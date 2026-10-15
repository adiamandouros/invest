import compression from 'compression';
import express from 'express';
import { createAuth } from './auth/index.js';
import { createStore } from './auth/store.js';
import { createDataStore } from './data/store.js';
import { checkDb } from './db.js';
import { createMarketUpdater } from './market/update.js';
import { createRenderer, messagePage, PAGES, PUBLIC_DIR, VENDOR, view } from './pages.js';
import { createPortfolio } from './portfolio/index.js';
import { securityHeaders } from './security.js';
import { VERSION } from './version.js';

// LiteSpeed is the only proxy in front of the app. Trust it, the nearest hop,
// when it connects over loopback or over a socket file (no address), so
// req.ip is the visitor's address and req.secure reflects HTTPS.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const trustProxy = (address, hop) => hop === 0 && (!address || LOOPBACK.has(address));

// The Express app, without listening, so tests can run it on any port.
// `db` is a mysql2 pool, or null when the database isn't configured; tests
// pass `store` and `data` (test/helpers/) instead.
export function createApp({
    db = null, store = db && createStore(db), data = db && createDataStore(db), encryptionKey = null, now = Date.now,
    // Price and rate updates; tests pass their own, or none
    market = db && data && createMarketUpdater(data),
} = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', trustProxy);
    app.use(compression());
    app.use(securityHeaders);

    const render = createRenderer();
    const send = (res, status, html) => res.status(status).set('Cache-Control', 'no-store').type('html').send(html);
    const message = ({ title, text }) => messagePage(render, { title, text });

    // For uptime checks: whether the app runs and reaches its database, and
    // which commit it runs (scripts/deploy.sh checks that it's the new one)
    app.get('/health', async (_req, res) => {
        const dbStatus = db ? await checkDb(db) : 'not configured';
        res.set('Cache-Control', 'no-store')
            .status(dbStatus === 'ok' ? 200 : 503)
            .json({ status: dbStatus === 'ok' ? 'ok' : 'degraded', db: dbStatus, version: VERSION });
    });

    // Stylesheets, scripts, icons and robots.txt: public, nothing private in them
    for (const [url, dir] of Object.entries(VENDOR)) app.use(url, express.static(dir));
    app.use(express.static(PUBLIC_DIR, { index: false }));

    // Everything below needs a session, except the sign-in pages
    const auth = createAuth({ store, encryptionKey, render, send, message, now });
    app.use(auth.sameOrigin);
    app.use(auth.loadSession);
    app.use(auth.router);
    app.use(auth.requireLogin);

    // The portfolio pages, including the overview at /; without data, the fixed pages
    if (data) app.use(createPortfolio({ data, market, render, send, message, now }));
    for (const [path, page] of Object.entries(PAGES)) {
        const content = view(page.view);
        app.get(path, (req, res) => send(res, 200, render({ title: page.title, content, session: req.session, path })));
    }

    const notFound = view('notfound');
    app.use((req, res) => send(res, 404, render({ title: 'Page not found', content: notFound, session: req.session })));

    // No stack traces on the page, whatever mode the app runs in
    app.use((err, req, res, _next) => {
        const status = err.status >= 400 && err.status < 500 ? err.status : 500;
        if (status === 500) console.error(err);
        send(res, status, messagePage(render, {
            title: status === 500 ? 'Something went wrong' : 'Request refused',
            text: status === 500 ? 'The app ran into an error. Try again in a moment.' : 'The app couldn\'t handle that request.',
            session: req.session,
        }));
    });
    return app;
}
