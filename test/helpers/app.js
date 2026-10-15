import assert from 'node:assert/strict';
import { createApp } from '../../server/app.js';
import { hashPassword } from '../../server/auth/password.js';
import { codeAt, stepAt } from '../../server/auth/totp.js';
import { createMemoryData } from './memory-data.js';
import { createMemoryStore } from './memory-store.js';

// The app on a random port with in-memory stores, one user, and a clock the test moves

export const KEY = 'test-key-'.repeat(4);
export const PASSWORD = 'a long test password';

export async function start({ encryptionKey = KEY, data = createMemoryData() } = {}) {
    const clock = { now: 1_700_000_000_000 };
    const now = () => clock.now;
    const store = createMemoryStore({ now });
    await store.createUser('me', await hashPassword(PASSWORD));
    const app = createApp({ store, data, encryptionKey, now });
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://localhost:${server.address().port}`;
    return { clock, store, data, base, browser: () => browser(base), close: () => server.close() };
}

// Keeps the session cookie between requests, like a browser. `form` is an
// object (sent URL-encoded) or a FormData (sent as multipart).
export function browser(base) {
    let cookie = '';
    async function request(method, path, form, headers = {}) {
        const multipart = form instanceof FormData;
        const res = await fetch(base + path, {
            method,
            redirect: 'manual',
            headers: {
                ...(cookie && { cookie }),
                ...(form && { origin: base }),
                ...(form && !multipart && { 'content-type': 'application/x-www-form-urlencoded' }),
                ...headers,
            },
            body: form && (multipart ? form : new URLSearchParams(form)),
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

export const csrfOf = html => html.match(/name="_csrf" value="([^"]+)"/)[1];
export const secretOf = html => html.match(/<code class="totp-key">([^<]+)<\/code>/)[1].replace(/ /g, '');
export const location = res => res.headers.get('location');

// Signs in through setup; returns the authenticator secret
export async function signUp(b, clock) {
    await b.post('/login', { username: 'me', password: PASSWORD });
    const setup = await (await b.get('/login/setup')).text();
    const secret = secretOf(setup);
    const res = await b.post('/login/setup', { _csrf: csrfOf(setup), code: codeAt(secret, stepAt(clock.now)) });
    assert.equal(location(res), '/');
    return secret;
}
