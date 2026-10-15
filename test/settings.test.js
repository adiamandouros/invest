import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeAt, stepAt } from '../server/auth/totp.js';
import { csrfOf, location, PASSWORD, secretOf, signUp, start } from './helpers/app.js';

const NEW_PASSWORD = 'another long password';
const code = (secret, clock) => codeAt(secret, stepAt(clock.now));
// Codes can't be used twice, so each one is from a later 30-second step
const tick = clock => { clock.now += 30_000; };

async function signIn(b, clock, secret, password = PASSWORD) {
    const res = await b.post('/login', { username: 'me', password });
    if (location(res) !== '/login/code') return res;
    const page = await (await b.get('/login/code')).text();
    tick(clock);
    return b.post('/login/code', { _csrf: csrfOf(page), code: code(secret, clock) });
}

test('settings need a session and the form\'s token', async () => {
    const app = await start();
    try {
        const b = app.browser();
        assert.equal(location(await b.get('/settings')), '/login');
        assert.equal((await b.post('/settings/password', { current: PASSWORD })).status, 401);
        await signUp(b, app.clock);
        const page = await (await b.get('/settings')).text();
        assert.match(page, /Signed in as <strong>me<\/strong>/);
        assert.match(page, /href="\/settings" aria-current="page"/);
        assert.match(page, /You're only signed in here/);
        assert.equal((await b.post('/settings/password', { _csrf: 'wrong', current: PASSWORD })).status, 403);
        assert.equal((await b.post('/settings/sessions', {})).status, 403);
    } finally {
        app.close();
    }
});

test('changing the password checks the current one, signs out other devices and keeps this one', async () => {
    const app = await start();
    try {
        const b = app.browser();
        const secret = await signUp(b, app.clock);
        const other = app.browser();
        assert.equal(location(await signIn(other, app.clock, secret)), '/');
        assert.match(await (await b.get('/settings')).text(), /signed in on 2 devices/);

        const csrf = csrfOf(await (await b.get('/settings')).text());
        const wrong = await b.post('/settings/password', { _csrf: csrf, current: 'not it at all', password: NEW_PASSWORD, repeat: NEW_PASSWORD });
        assert.equal(wrong.status, 401);
        assert.match(await wrong.text(), /That isn&#39;t your current password|That isn't your current password/);
        const short = await (await b.post('/settings/password', { _csrf: csrf, current: PASSWORD, password: 'short', repeat: 'short' })).text();
        assert.match(short, /Use at least 12 characters \(this has 5\)/);
        assert.match(short, /id="f-password" name="password" type="password" class="form-control is-invalid"/);
        const differ = await (await b.post('/settings/password', { _csrf: csrf, current: PASSWORD, password: NEW_PASSWORD, repeat: 'something else' })).text();
        assert.match(differ, /aren&#39;t the same|aren't the same/);

        const before = b.cookie;
        const done = await b.post('/settings/password', { _csrf: csrf, current: PASSWORD, password: NEW_PASSWORD, repeat: NEW_PASSWORD });
        assert.equal(location(done), '/settings?done=password');
        assert.notEqual(b.cookie, before, 'a new session here');
        assert.match(await (await b.get('/settings?done=password')).text(), /Your password is changed/);
        assert.equal(location(await other.get('/')), '/login', 'the other device is signed out');

        assert.equal((await app.browser().post('/login', { username: 'me', password: PASSWORD })).status, 401, 'the old password no longer works');
        assert.equal(location(await signIn(app.browser(), app.clock, secret, NEW_PASSWORD)), '/');
    } finally {
        app.close();
    }
});

test('moving to a new authenticator app: password and current code, then a code from the new app', async () => {
    const app = await start();
    try {
        const b = app.browser();
        const oldSecret = await signUp(b, app.clock);
        const other = app.browser();
        await signIn(other, app.clock, oldSecret);
        const csrf = csrfOf(await (await b.get('/settings')).text());
        assert.equal(location(await b.get('/settings/authenticator')), '/settings', 'nothing started yet');

        tick(app.clock);
        const badCode = await b.post('/settings/authenticator', { _csrf: csrf, authCurrent: PASSWORD, code: '000000' });
        assert.equal(badCode.status, 401);
        assert.match(await badCode.text(), /That code didn&#39;t work|That code didn't work/);
        const badPassword = await b.post('/settings/authenticator', { _csrf: csrf, authCurrent: 'nope', code: code(oldSecret, app.clock) });
        assert.equal(badPassword.status, 401);

        tick(app.clock);
        assert.equal(location(await b.post('/settings/authenticator', { _csrf: csrf, authCurrent: PASSWORD, code: code(oldSecret, app.clock) })), '/settings/authenticator');
        const setup = await (await b.get('/settings/authenticator')).text();
        assert.match(setup, /<svg role="img" aria-label="QR code for your authenticator app"/);
        const newSecret = secretOf(setup);
        assert.notEqual(newSecret, oldSecret);
        assert.equal(secretOf(await (await b.get('/settings/authenticator')).text()), newSecret, 'the same key on reload');

        const wrong = await b.post('/settings/authenticator/confirm', { _csrf: csrf, code: code(oldSecret, app.clock) });
        assert.equal(wrong.status, 401, 'a code from the old app doesn\'t confirm the new one');
        tick(app.clock);
        assert.equal(location(await b.post('/settings/authenticator/confirm', { _csrf: csrf, code: code(newSecret, app.clock) })), '/settings?done=authenticator');
        assert.match(await (await b.get('/settings?done=authenticator')).text(), /Your new authenticator app is set up/);
        assert.equal(location(await other.get('/')), '/login', 'the other device is signed out');
        assert.equal(location(await b.get('/settings/authenticator')), '/settings', 'nothing pending any more');

        // Signing in now needs the new app
        const c = app.browser();
        await c.post('/login', { username: 'me', password: PASSWORD });
        const page = await (await c.get('/login/code')).text();
        tick(app.clock);
        assert.equal((await c.post('/login/code', { _csrf: csrfOf(page), code: code(oldSecret, app.clock) })).status, 401);
        tick(app.clock);
        assert.equal(location(await c.post('/login/code', { _csrf: csrfOf(page), code: code(newSecret, app.clock) })), '/');
    } finally {
        app.close();
    }
});

test('cancelling keeps the old app; signing out other devices', async () => {
    const app = await start();
    try {
        const b = app.browser();
        const secret = await signUp(b, app.clock);
        const csrf = csrfOf(await (await b.get('/settings')).text());
        tick(app.clock);
        await b.post('/settings/authenticator', { _csrf: csrf, authCurrent: PASSWORD, code: code(secret, app.clock) });
        assert.equal(location(await b.post('/settings/authenticator/cancel', { _csrf: csrf })), '/settings');
        assert.equal(location(await b.get('/settings/authenticator')), '/settings');
        assert.equal(location(await signIn(app.browser(), app.clock, secret)), '/', 'the old app still works');

        const other = app.browser();
        await signIn(other, app.clock, secret);
        assert.match(await (await b.get('/settings')).text(), /signed in on 3 devices/);
        assert.equal(location(await b.post('/settings/sessions', { _csrf: csrf })), '/settings?done=signed-out');
        assert.equal(location(await other.get('/')), '/login');
        assert.equal((await b.get('/settings')).status, 200, 'this one stays signed in');
        assert.match(await (await b.get('/settings')).text(), /You're only signed in here/);
    } finally {
        app.close();
    }
});
