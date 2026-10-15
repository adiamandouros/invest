import { randomBytes, timingSafeEqual } from 'crypto';
import express from 'express';
import { applyImport, parseStatement, planImport } from '../import/index.js';
import { ZERO } from '../lib/decimal.js';
import { cash, positions } from '../lib/holdings.js';
import { parseMultipart } from '../multipart.js';
import { doneContent, holdingsContent, importContent, previewContent, transactionsContent } from './views.js';

// The signed-in pages for holdings, transactions and importing statements.
// `data`: server/data/store.js. `render`, `send`, `message`: from server/app.js.

const PENDING_MS = 30 * 60_000; // how long a previewed import waits for "Import"

const sameString = (a, b) => typeof a === 'string' && typeof b === 'string'
    && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createPortfolio({ data, render, send, message, now = Date.now }) {
    const router = express.Router();
    const form = express.urlencoded({ extended: false, limit: '2kb' });
    const upload = express.raw({ type: 'multipart/form-data', limit: '20mb' });
    const page = (req, res, title, content, status = 200) =>
        send(res, status, render({ title, content, session: req.session, path: req.path }));
    const forbidden = res => send(res, 403, message({
        title: 'Form expired', text: 'This form is no longer valid. Go back, reload the page and try again.',
    }));

    // Statements previewed and waiting for "Import": id → { userId, statement, expires }
    const pending = new Map();
    function remember(userId, statement) {
        for (const [id, p] of pending) if (p.expires < now() || p.userId === userId) pending.delete(id);
        const id = randomBytes(16).toString('base64url');
        pending.set(id, { userId, statement, expires: now() + PENDING_MS });
        return id;
    }

    async function loadAll() {
        const [accounts, instruments, transactions] = await Promise.all([
            data.listAccounts(), data.listInstruments(), data.listTransactions(),
        ]);
        return {
            accounts: new Map(accounts.map(a => [a.id, a])),
            instruments: new Map(instruments.map(i => [i.id, i])),
            transactions,
        };
    }

    router.get('/holdings', async (req, res) => {
        const { accounts, instruments, transactions } = await loadAll();
        const rows = transactions.map(t => ({ ...t, account: t.accountId, instrument: t.instrumentId }));
        const all = [...positions(rows).values()]
            .map(position => ({ instrument: instruments.get(position.instrument), position }))
            .sort((a, b) => a.instrument.symbol.localeCompare(b.instrument.symbol));
        const balances = [...cash(rows)]
            .filter(([, amount]) => amount !== ZERO)
            .map(([key, amount]) => {
                const [accountId, currency] = key.split('|');
                return { account: accounts.get(Number(accountId)), currency, amount };
            });
        page(req, res, 'Holdings', holdingsContent({
            open: all.filter(h => h.position.units !== ZERO),
            closed: all.filter(h => h.position.units === ZERO),
            balances,
        }));
    });

    router.get('/transactions', async (req, res) => {
        const { accounts, instruments, transactions } = await loadAll();
        const instrument = instruments.get(Number(req.query.instrument)) ?? null;
        const rows = transactions
            .filter(t => !instrument || t.instrumentId === instrument.id)
            .map(t => ({ ...t, account: accounts.get(t.accountId), instrument: instruments.get(t.instrumentId) ?? null }));
        page(req, res, instrument ? `${instrument.symbol} transactions` : 'Transactions', transactionsContent({ rows, instrument }));
    });

    // ── Importing statements ────────────────────────────────────────────────

    router.get('/import', (req, res) => page(req, res, 'Import', importContent({ csrf: req.session.csrf })));

    router.post('/import/preview', upload, async (req, res) => {
        let parsed;
        try {
            parsed = parseMultipart(req.body, req.get('content-type'));
        } catch {
            return forbidden(res);
        }
        if (!sameString(parsed.fields._csrf, req.session.csrf)) return forbidden(res);
        const fail = error => page(req, res, 'Import', importContent({ csrf: req.session.csrf, error }), 400);
        const file = parsed.files.statement;
        if (!file?.data.length) return fail('Choose a report file to upload.');

        let statement;
        try {
            statement = parseStatement(file.data.toString('utf8'));
        } catch (err) {
            return fail(err.message);
        }
        const plan = await planImport(statement, data);
        const id = remember(req.session.userId, statement);
        page(req, res, 'Check the import', previewContent({ plan, csrf: req.session.csrf, id }));
    });

    router.post('/import/confirm', form, async (req, res) => {
        if (!sameString(req.body?._csrf, req.session.csrf)) return forbidden(res);
        const waiting = pending.get(String(req.body?.id ?? ''));
        if (!waiting || waiting.userId !== req.session.userId || waiting.expires < now()) {
            return page(req, res, 'Import', importContent({
                csrf: req.session.csrf, error: 'That preview has expired. Upload the report again.',
            }), 410);
        }
        pending.delete(req.body.id);
        // Planned again, in case something was imported since the preview
        const plan = await planImport(waiting.statement, data);
        const { added } = await applyImport(plan, data);
        page(req, res, 'Import finished', doneContent({ added, account: plan.account.name }));
    });

    return router;
}
