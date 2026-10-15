import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import express from 'express';
import { createLimiter } from './limiter.js';
import { hashPassword, MIN_PASSWORD, verifyNoPassword, verifyPassword } from './password.js';
import { seal, unseal } from './secrets.js';
import { generateSecret, otpauthUri, verifyCode } from './totp.js';
import { newAuthenticatorContent, settingsContent } from './settings-views.js';
import { codePage, loginPage, setupPage } from './views.js';

// Sign-in in two steps: username and password, then a code from an
// authenticator app (set up on the first sign-in). Sessions live in the
// sessions table; the cookie holds a random token and the table only its hash.
//
// Every POST needs a same-site Origin, and once there's a session, that
// session's CSRF token as the form field _csrf.

// __Host-: the browser only accepts the cookie over HTTPS, for this exact host and path /
export const COOKIE = '__Host-session';
export const SESSION_SECONDS = 14 * 86_400;
const PENDING_SECONDS = 10 * 60; // to enter the code after the password
const MAX_FAILURES = 10; // in a row, per user, before a lock
const LOCK_SECONDS = 15 * 60;

const TOO_MANY = 'Too many failed attempts. Try again in 15 minutes.';
const WRONG_CODE = 'That code didn\'t work. Enter the newest code your app shows for Invest.';

const newToken = () => randomBytes(32).toString('base64url');
const hashToken = token => createHash('sha256').update(token).digest('hex');

function readCookie(req, name) {
    for (const part of (req.headers.cookie ?? '').split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
}

const sameString = (a, b) => typeof a === 'string' && typeof b === 'string'
    && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// `store`: server/auth/store.js, or null when the database isn't configured.
// `encryptionKey`: ENCRYPTION_KEY, for the stored authenticator secrets.
// `render`, `send`, `message`: from server/app.js.
export function createAuth({ store, encryptionKey, render, send, message, now = Date.now }) {
    const limiter = createLimiter({ now });
    const router = express.Router();
    const form = express.urlencoded({ extended: false, limit: '2kb' });
    const cookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };

    async function startSession(res, userId, stage) {
        const token = newToken();
        const seconds = stage === 'full' ? SESSION_SECONDS : PENDING_SECONDS;
        await store.createSession({ tokenHash: hashToken(token), userId, stage, csrf: newToken(), seconds });
        res.cookie(COOKIE, token, { ...cookieOptions, maxAge: seconds * 1000 });
    }

    async function endSession(req, res) {
        if (req.session) await store.deleteSession(req.session.tokenHash);
        req.session = null;
        res.clearCookie(COOKIE, cookieOptions);
    }

    const forbidden = res => send(res, 403, message({
        title: 'Form expired',
        text: 'This form is no longer valid. Go back, reload the page and try again.',
    }));
    const csrfOk = req => sameString(req.body?._csrf, req.session?.csrf);

    // The user whose password step is done and code step isn't. Otherwise
    // answers the request itself and returns null.
    async function pendingUser(req, res) {
        if (req.session?.stage !== 'password') {
            res.redirect(303, '/login');
            return null;
        }
        const user = await store.findUserById(req.session.userId);
        if (!user?.locked) return user;
        await endSession(req, res);
        send(res, 429, loginPage(render, { error: TOO_MANY }));
        return null;
    }

    async function failedCode(req, user) {
        limiter.fail(req.ip);
        await store.recordFailedLogin(user.id, MAX_FAILURES, LOCK_SECONDS);
    }

    // Both steps are done: replace the half-way session with a full one
    async function finishLogin(req, res, user) {
        await store.deleteSession(req.session.tokenHash);
        await store.clearFailedLogins(user.id);
        await store.deleteExpiredSessions();
        limiter.reset(req.ip);
        await startSession(res, user.id, 'full');
        res.redirect(303, '/');
    }

    // ── Middleware ──────────────────────────────────────────────────────────

    // Sets req.session from the cookie: { tokenHash, userId, username, stage, csrf, pendingTotp } or null
    async function loadSession(req, _res, next) {
        const token = readCookie(req, COOKIE);
        req.session = token && store ? await store.findSession(hashToken(token)) : null;
        next();
    }

    // Refuse POSTs sent from other sites. (Browsers always send Origin with those.)
    function sameOrigin(req, res, next) {
        const origin = req.get('origin');
        if (req.method === 'GET' || req.method === 'HEAD' || !origin) return next();
        let host = null;
        try { host = new URL(origin).host; } catch { /* not a URL */ }
        if (host === req.get('host')) return next();
        forbidden(res);
    }

    function requireLogin(req, res, next) {
        if (req.session?.stage === 'full') return next();
        if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(303, '/login');
        send(res, 401, message({ title: 'Signed out', text: 'Sign in again to continue.' }));
    }

    // ── Step 1: username and password ───────────────────────────────────────

    router.get('/login', (req, res) => {
        if (req.session?.stage === 'full') return res.redirect(303, '/');
        send(res, 200, loginPage(render));
    });

    router.post('/login', form, async (req, res) => {
        const username = String(req.body?.username ?? '').trim().slice(0, 64);
        const password = String(req.body?.password ?? '');
        const fail = (status, error) => send(res, status, loginPage(render, { error, username }));

        if (!store || !encryptionKey) {
            console.error('[auth] Sign-in needs the database and ENCRYPTION_KEY (see .env.example)');
            return fail(503, 'Sign-in isn\'t set up on this server yet.');
        }
        if (limiter.blocked(req.ip)) return fail(429, TOO_MANY);
        const user = username ? await store.findUserByName(username) : null;
        if (user?.locked) return fail(429, TOO_MANY);
        if (!(user ? await verifyPassword(password, user.passwordHash) : await verifyNoPassword(password))) {
            limiter.fail(req.ip);
            if (user) await store.recordFailedLogin(user.id, MAX_FAILURES, LOCK_SECONDS);
            return fail(401, 'Wrong username or password.');
        }

        if (req.session) await store.deleteSession(req.session.tokenHash);
        await startSession(res, user.id, 'password');
        res.redirect(303, user.totpSecret ? '/login/code' : '/login/setup');
    });

    // ── Step 2: the authenticator code ──────────────────────────────────────

    router.get('/login/code', async (req, res) => {
        const user = await pendingUser(req, res);
        if (!user) return;
        if (!user.totpSecret) return res.redirect(303, '/login/setup');
        send(res, 200, codePage(render, { csrf: req.session.csrf }));
    });

    router.post('/login/code', form, async (req, res) => {
        const user = await pendingUser(req, res);
        if (!user) return;
        if (!csrfOk(req)) return forbidden(res);
        if (!user.totpSecret) return res.redirect(303, '/login/setup');
        const fail = (status, error) => send(res, status, codePage(render, { csrf: req.session.csrf, error }));
        if (limiter.blocked(req.ip)) return fail(429, TOO_MANY);

        const step = verifyCode(unseal(user.totpSecret, encryptionKey), req.body?.code, now());
        if (step === null || !await store.useTotpStep(user.id, step)) {
            await failedCode(req, user);
            return fail(401, WRONG_CODE);
        }
        await finishLogin(req, res, user);
    });

    // ── First sign-in: set up the authenticator app ─────────────────────────

    router.get('/login/setup', async (req, res) => {
        const user = await pendingUser(req, res);
        if (!user) return;
        if (user.totpSecret) return res.redirect(303, '/login/code');
        // The secret stays the same on reload, so a QR code already scanned keeps working
        let secret = req.session.pendingTotp && unseal(req.session.pendingTotp, encryptionKey);
        if (!secret) {
            secret = generateSecret();
            await store.setPendingTotp(req.session.tokenHash, seal(secret, encryptionKey));
        }
        send(res, 200, await setupPage(render, { csrf: req.session.csrf, secret, uri: otpauthUri(secret, user.username) }));
    });

    router.post('/login/setup', form, async (req, res) => {
        const user = await pendingUser(req, res);
        if (!user) return;
        if (!csrfOk(req)) return forbidden(res);
        if (user.totpSecret) return res.redirect(303, '/login/code');
        if (!req.session.pendingTotp) return res.redirect(303, '/login/setup');
        const secret = unseal(req.session.pendingTotp, encryptionKey);
        const fail = async (status, error) => send(res, status, await setupPage(render,
            { csrf: req.session.csrf, secret, uri: otpauthUri(secret, user.username), error }));
        if (limiter.blocked(req.ip)) return fail(429, TOO_MANY);

        const step = verifyCode(secret, req.body?.code, now());
        if (step === null || !await store.enableTotp(user.id, req.session.pendingTotp, step)) {
            await failedCode(req, user);
            return fail(401, WRONG_CODE);
        }
        await finishLogin(req, res, user);
    });

    // ── Settings: password, authenticator app, other devices ───────────────

    const settingsPage = (req, res, title, content, status = 200) =>
        send(res, status, render({ title, content, session: req.session, path: '/settings' }));

    // The signed-in user, after the form's token check; otherwise answers the request itself
    async function settingsUser(req, res) {
        if (req.session?.stage !== 'full') {
            if (req.method === 'GET') res.redirect(303, '/login');
            else send(res, 401, message({ title: 'Signed out', text: 'Sign in again to continue.' }));
            return null;
        }
        if (req.method === 'POST' && !csrfOk(req)) {
            forbidden(res);
            return null;
        }
        return store.findUserById(req.session.userId);
    }
    const showSettings = async (req, res, extra = {}, status = 200) => settingsPage(req, res, 'Settings', settingsContent({
        csrf: req.session.csrf, username: req.session.username, sessions: await store.countSessions(req.session.userId), ...extra,
    }), status);
    // Too many wrong passwords or codes, here or at sign-in
    const tooMany = (req, user) => limiter.blocked(req.ip) || user.locked;
    async function failed(req, user) {
        limiter.fail(req.ip);
        await store.recordFailedLogin(user.id, MAX_FAILURES, LOCK_SECONDS);
    }

    router.get('/settings', async (req, res) => {
        if (!await settingsUser(req, res)) return;
        await showSettings(req, res, { done: String(req.query.done ?? '') });
    });

    router.post('/settings/password', form, async (req, res) => {
        const user = await settingsUser(req, res);
        if (!user) return;
        const fail = (errors, status = 400) => showSettings(req, res, { form: 'password', errors }, status);
        if (tooMany(req, user)) return fail({ current: TOO_MANY }, 429);
        const password = String(req.body?.password ?? '');
        const errors = {};
        if (!await verifyPassword(String(req.body?.current ?? ''), user.passwordHash)) errors.current = 'That isn\'t your current password.';
        if (password.length < MIN_PASSWORD) errors.password = `Use at least ${MIN_PASSWORD} characters (this has ${password.length}).`;
        else if (password.length > 200) errors.password = 'Use at most 200 characters.';
        else if (String(req.body?.repeat ?? '') !== password) errors.repeat = 'The two new passwords aren\'t the same.';
        if (errors.current) await failed(req, user);
        if (Object.keys(errors).length) return fail(errors, errors.current ? 401 : 400);

        // Signs out every session, this one too; then a new one here
        await store.setPassword(user.id, await hashPassword(password));
        limiter.reset(req.ip);
        await startSession(res, user.id, 'full');
        res.redirect(303, '/settings?done=password');
    });

    // Step 1: the current password and code, then a new secret for this session
    router.post('/settings/authenticator', form, async (req, res) => {
        const user = await settingsUser(req, res);
        if (!user) return;
        const fail = (errors, status) => showSettings(req, res, { form: 'authenticator', errors }, status);
        if (tooMany(req, user)) return fail({ authCurrent: TOO_MANY }, 429);
        if (!await verifyPassword(String(req.body?.authCurrent ?? ''), user.passwordHash)) {
            await failed(req, user);
            return fail({ authCurrent: 'That isn\'t your current password.' }, 401);
        }
        const step = user.totpSecret ? verifyCode(unseal(user.totpSecret, encryptionKey), req.body?.code, now()) : null;
        if (step === null || !await store.useTotpStep(user.id, step)) {
            await failed(req, user);
            return fail({ code: WRONG_CODE }, 401);
        }
        await store.setPendingTotp(req.session.tokenHash, seal(generateSecret(), encryptionKey));
        res.redirect(303, '/settings/authenticator');
    });

    router.get('/settings/authenticator', async (req, res) => {
        if (!await settingsUser(req, res)) return;
        if (!req.session.pendingTotp) return res.redirect(303, '/settings');
        const secret = unseal(req.session.pendingTotp, encryptionKey);
        settingsPage(req, res, 'New authenticator app', await newAuthenticatorContent({
            csrf: req.session.csrf, secret, uri: otpauthUri(secret, req.session.username),
        }));
    });

    // Step 2: a code from the new app switches to it
    router.post('/settings/authenticator/confirm', form, async (req, res) => {
        const user = await settingsUser(req, res);
        if (!user) return;
        if (!req.session.pendingTotp) return res.redirect(303, '/settings');
        const secret = unseal(req.session.pendingTotp, encryptionKey);
        const fail = async (status, error) => settingsPage(req, res, 'New authenticator app', await newAuthenticatorContent({
            csrf: req.session.csrf, secret, uri: otpauthUri(secret, req.session.username), error,
        }), status);
        if (tooMany(req, user)) return fail(429, TOO_MANY);
        const step = verifyCode(secret, req.body?.code, now());
        if (step === null) {
            await failed(req, user);
            return fail(401, 'That code didn\'t work. Enter the newest code the new app shows for Invest.');
        }
        await store.replaceTotp(user.id, req.session.pendingTotp, step);
        await store.setPendingTotp(req.session.tokenHash, null);
        await store.deleteOtherSessions(user.id, req.session.tokenHash);
        await store.clearFailedLogins(user.id);
        limiter.reset(req.ip);
        res.redirect(303, '/settings?done=authenticator');
    });

    router.post('/settings/authenticator/cancel', form, async (req, res) => {
        if (!await settingsUser(req, res)) return;
        await store.setPendingTotp(req.session.tokenHash, null);
        res.redirect(303, '/settings');
    });

    router.post('/settings/sessions', form, async (req, res) => {
        const user = await settingsUser(req, res);
        if (!user) return;
        await store.deleteOtherSessions(user.id, req.session.tokenHash);
        res.redirect(303, '/settings?done=signed-out');
    });

    // ── Sign out (also "start over" from step 2) ────────────────────────────

    router.post('/logout', form, async (req, res) => {
        if (req.session && !csrfOk(req)) return forbidden(res);
        await endSession(req, res);
        res.redirect(303, '/login');
    });

    return { loadSession, sameOrigin, requireLogin, router };
}
