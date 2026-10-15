import compression from 'compression';
import express from 'express';
import { checkDb } from './db.js';
import { PUBLIC_DIR, renderPages, VENDOR } from './pages.js';
import { securityHeaders } from './security.js';

// The Express app, without listening, so tests can run it on any port.
// `db` is a mysql2 pool, or null when the database isn't configured.
export function createApp({ db = null } = {}) {
    const app = express();
    app.disable('x-powered-by');
    // Behind cPanel's proxy: trust its X-Forwarded-* headers for req.ip and req.secure
    app.set('trust proxy', 'loopback');
    app.use(compression());
    app.use(securityHeaders);

    // For uptime checks: whether the app runs and reaches its database
    app.get('/health', async (_req, res) => {
        const dbStatus = db ? await checkDb(db) : 'not configured';
        res.set('Cache-Control', 'no-store')
            .status(dbStatus === 'ok' ? 200 : 503)
            .json({ status: dbStatus === 'ok' ? 'ok' : 'degraded', db: dbStatus });
    });

    const { pages, notFound } = renderPages();
    for (const [path, html] of Object.entries(pages)) {
        app.get(path, (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(html));
    }

    for (const [url, dir] of Object.entries(VENDOR)) app.use(url, express.static(dir));
    app.use(express.static(PUBLIC_DIR, { index: false }));

    app.use((_req, res) => res.status(404).type('html').send(notFound));
    return app;
}
