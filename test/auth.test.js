import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/auth/password.js';
import { codeAt, stepAt } from '../server/auth/totp.js';
import { createMemoryStore } from './helpers/memory-store.js';

const KEY = 'test-key-'.repeat(4);
const PASSWORD = 'a long test password';

// An app with one user, on a clock the test moves
async function start({ encryptionKey = KEY } = {}) {
    const clock = { now: 1_700_000_000_000 };
    const now = () => clock.now;
    const store = createMemoryStore({ now });
    await store.createUser('me', await hashPassword(PASSWORD));
    const app = createApp({ store, encryptionKey, now });
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://localhost:${server.address().port}`;
    return { clock, store, base, browser: () => browser(base), close: () => server.close() };
}

// Keeps the session cookie between requests, like a browser
function browser(base) {
    let cookie = '';
    async function request(method, path, form, headers = {}) {
        const res = await fetch(base + path, {
            method,
            redirect: 'manual',
            headers: {
                ...(cookie && { cookie }),
                ...(form && { 'content-type': 'application/x-www-form-urlencoded', origin: base }),
                ...headers,
            },
            body: form && new URLSearchParams(form),
        });
        for (const set of res.headers.getSetCookie()) {
            const [name, value] = set.split(';')[0].split('=');
            cookie = value ? `${name}=${value}` : '';
        }
        return res;
    }
    return {
        get: path => request('GET', path),
        post: (path, form, headers) => request('POST', path, form, headers),
        get cookie() { return cookie; },
    };
}

const csrfOf = html => html.match(/name="_csrf" value="([^"]+)"/)[1];
const secretOf = html => html.match(/<code class="totp-key">([^<]+)<\/code>/)[1].replace(/ /g, '');
const location = res => res.headers.get('location');

// Signs in through setup; returns the authenticator secret
async function signUp(b, clock) {
    await b.post('/login', { username: 'me', password: PASSWORD });
    const setup = await (await b.get('/login/setup')).text();
    const secret = secretOf(setup);
    const res = await b.post('/login/setup', { _csrf: csrfOf(setup), code: codeAt(secret, stepAt(clock.now)) });
    assert.equal(location(res), '/');
    return secret;
}

test('signed out, every page sends you to sign in; assets and /health stay open', async () => {
    const app = await start();
    try {
        const b = app.browser();
        for (const path of ['/', '/nowhere']) {
            const res = await b.get(path);
            assert.equal(res.status, 303, path);
            assert.equal(location(res), '/login');
        }
        assert.equal((await b.get('/login')).status, 200);
        for (const path of ['/health', '/robots.txt', '/css/style.css', '/icon/favicon.svg']) {
            assert.notEqual((await b.get(path)).status, 303, path);
        }
        const res = await b.post('/logout', {});
        assert.equal(location(res), '/login', 'signing out without a session is harmless');
    } finally {
        app.close();
    }
});

test('the first sign-in sets up the authenticator app, then shows the overview', async () => {
    const app = await start();
    try {
        const b = app.browser();
        const res = await b.post('/login', { username: 'me', password: PASSWORD });
        assert.equal(res.status, 303);
        assert.equal(location(res), '/login/setup');
        const cookie = res.headers.getSetCookie()[0];
        for (const part of ['__Host-session=', 'Max-Age=600', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) {
            assert.ok(cookie.includes(part), `cookie has ${part}: ${cookie}`);
        }
        const halfway = b.cookie;

        assert.equal(location(await b.get('/')), '/login', 'no pages before the code');
        assert.equal(location(await b.get('/login/code')), '/login/setup');

        const setup = await (await b.get('/login/setup')).text();
        assert.match(setup, /<svg role="img" aria-label="QR code/);
        const secret = secretOf(setup);
        assert.equal(secretOf(await (await b.get('/login/setup')).text()), secret, 'the same secret on reload');

        const wrong = await b.post('/login/setup', { _csrf: csrfOf(setup), code: '000000' });
        assert.equal(wrong.status, 401);
        assert.match(await wrong.text(), /That code didn&#39;t work/);

        const done = await b.post('/login/setup', { _csrf: csrfOf(setup), code: codeAt(secret, stepAt(app.clock.now)) });
        assert.equal(location(done), '/');
        assert.notEqual(b.cookie, halfway, 'a new session token after signing in');
        assert.match(done.headers.getSetCookie()[0], /Max-Age=1209600/);

        const overview = await b.get('/');
        assert.equal(overview.status, 200);
        assert.match(await overview.text(), /Sign out/);
        assert.equal((await b.get('/nowhere')).status, 404);
        assert.equal(location(await b.get('/login')), '/', 'already signed in');
    } finally {
        app.close();
    }
});

test('later sign-ins ask for a code, and each code works only once', async () => {
    const app = await start();
    try {
        const b = app.browser();
        const secret = await signUp(b, app.clock);
        const code = codeAt(secret, stepAt(app.clock.now));

        const page = await (await b.get('/')).text();
        assert.equal(location(await b.post('/logout', { _csrf: csrfOf(page) })), '/login');
        assert.equal(b.cookie, '');
        assert.equal(location(await b.get('/')), '/login');

        assert.equal(location(await b.post('/login', { username: 'ME', password: PASSWORD })), '/login/code');
        const form = await (await b.get('/login/code')).text();
        const reused = await b.post('/login/code', { _csrf: csrfOf(form), code });
        assert.equal(reused.status, 401, 'the code used for setup is refused');

        app.clock.now += 30_000;
        const next = codeAt(secret, stepAt(app.clock.now));
        assert.equal(location(await b.post('/login/code', { _csrf: csrfOf(form), code: next })), '/');
        assert.equal((await b.get('/')).status, 200);
    } finally {
        app.close();
    }
});

test('sessions end after 14 days', async () => {
    const app = await start();
    try {
        const b = app.browser();
        await signUp(b, app.clock);
        app.clock.now += 14 * 86_400_000;
        assert.equal(location(await b.get('/')), '/login');
    } finally {
        app.close();
    }
});

test('wrong passwords are limited per client, and repeated failures lock the user', async () => {
    const app = await start();
    try {
        const b = app.browser();
        for (let i = 0; i < 5; i++) {
            const res = await b.post('/login', { username: 'me', password: 'wrong password' });
            assert.equal(res.status, 401);
            assert.match(await res.text(), /Wrong username or password/);
        }
        const blocked = await b.post('/login', { username: 'me', password: PASSWORD });
        assert.equal(blocked.status, 429, 'even the right password, once blocked');
        assert.equal((await b.post('/login', { username: 'nobody', password: 'x' })).status, 429);

        // The client block lasts 15 minutes; the user's count carries on
        app.clock.now += 15 * 60_000;
        for (let i = 0; i < 4; i++) await b.post('/login', { username: 'me', password: 'wrong password' });
        app.clock.now += 15 * 60_000;
        await b.post('/login', { username: 'me', password: 'wrong password' });
        const [user] = app.store.users.values();
        assert.ok(user.lockedUntil > app.clock.now, 'locked after 10 failures in a row');
        const locked = await app.browser().post('/login', { username: 'me', password: PASSWORD });
        assert.equal(locked.status, 429, 'locked for every client');
    } finally {
        app.close();
    }
});

test('forms need the session\'s token, and must come from this site', async () => {
    const app = await start();
    try {
        const b = app.browser();
        await signUp(b, app.clock);
        assert.equal((await b.post('/logout', {})).status, 403, 'no token');
        assert.equal((await b.post('/logout', { _csrf: 'x'.repeat(43) })).status, 403, 'wrong token');
        assert.equal((await b.get('/')).status, 200, 'still signed in');

        const page = await (await b.get('/')).text();
        const other = await b.post('/logout', { _csrf: csrfOf(page) }, { origin: 'https://evil.example' });
        assert.equal(other.status, 403);
        assert.equal((await b.get('/')).status, 200, 'still signed in');

        assert.equal((await app.browser().post('/login', { username: 'me', password: PASSWORD }, { origin: 'https://evil.example' })).status, 403);
    } finally {
        app.close();
    }
});

test('sign-in is refused, not broken, without a database or ENCRYPTION_KEY', async () => {
    for (const app of [createApp(), createApp({ store: createMemoryStore() })]) {
        const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
        const errors = console.error;
        console.error = () => {};
        try {
            const res = await browser(`http://localhost:${server.address().port}`).post('/login', { username: 'me', password: PASSWORD });
            assert.equal(res.status, 503);
            assert.match(await res.text(), /isn&#39;t set up on this server/);
        } finally {
            console.error = errors;
            server.close();
        }
    }
});
