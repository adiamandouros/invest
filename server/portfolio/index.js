import { randomBytes, timingSafeEqual } from 'crypto';
import express from 'express';
import { applyImport, parseStatement, planImport } from '../import/index.js';
import { allocation } from '../lib/allocation.js';
import { benchmark } from '../lib/benchmark.js';
import { backup, transactionsCsv } from '../lib/export.js';
import { DEFAULT_DIVIDEND_RATE, DEFAULT_RATE, taxYear } from '../lib/tax.js';
import { fixed } from '../lib/decimal.js';
import { summariseP2p } from '../lib/p2p.js';
import { project, spreadOf } from '../lib/projection.js';
import { createReports } from '../lib/reports.js';
import { createPrices, createRates, valuePortfolio } from '../lib/valuation.js';
import { parseMultipart } from '../multipart.js';
import {
    accountFields, accountForm, accountsContent, deleteTransactionContent, instrumentFields, instrumentForm,
    instrumentsContent, transactionForm,
} from './edit-views.js';
import { allocationContent, allocationForm } from './allocation-views.js';
import { number, parseAccount, parseAllocation, parseBalance, parseInstrument, parseTransaction, transactionFields } from './forms.js';
import { balanceForm, p2pAccountContent, p2pListContent } from './p2p-views.js';
import { dashboardContent, dashboardNotices } from './dashboard-views.js';
import { exportContent } from './export-views.js';
import { taxContent, taxCsv } from './tax-views.js';
import { projectionContent } from './projection-views.js';
import { CHART_SCRIPTS, reportsContent, yearContent, yearCsv, yearsCsv } from './reports-views.js';
import { doneContent, holdingsContent, importContent, previewContent, transactionsContent, TYPE_LABELS } from './views.js';

// The signed-in pages for holdings, P2P accounts, transactions and importing statements.
// `data`: server/data/store.js. `render`, `send`, `message`: from server/app.js.

const PENDING_MS = 30 * 60_000; // how long a previewed import waits for "Import"

const sameString = (a, b) => typeof a === 'string' && typeof b === 'string'
    && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// `market`: server/market/update.js createMarketUpdater(), or null for no price updates.
export function createPortfolio({ data, market = null, render, send, message, now = Date.now }) {
    const router = express.Router();
    const form = express.urlencoded({ extended: false, limit: '2kb' });
    const upload = express.raw({ type: 'multipart/form-data', limit: '20mb' });
    const page = (req, res, title, content, status = 200, scripts = []) =>
        send(res, status, render({ title, content, scripts, session: req.session, path: req.path }));
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

    const today = () => new Date(now()).toISOString().slice(0, 10);

    // server/lib/p2p.js summaries for every P2P account, by name
    async function p2pSummaries(accounts, transactions) {
        const balances = await data.listBalances();
        return [...accounts.values()].filter(a => a.kind === 'p2p').map(account => summariseP2p({
            account,
            rows: transactions.filter(t => t.accountId === account.id),
            balances: balances.filter(b => b.accountId === account.id),
            today: today(),
        }));
    }

    // Everything valued today (server/lib/valuation.js), P2P accounts at their summaries' values
    async function valueAll() {
        const [{ accounts, instruments, transactions }, prices, rates] = await Promise.all([loadAll(), data.listPrices(), data.listFxRates()]);
        const p2p = await p2pSummaries(accounts, transactions);
        const valuation = valuePortfolio({
            transactions: transactions.map(t => ({ ...t, account: t.accountId, instrument: t.instrumentId })),
            priceOf: createPrices(prices), eurPer: createRates(rates), today: today(),
            accountValues: new Map(p2p.map(s => [`${s.account.id}|${s.currency}`, s.value])),
        });
        return { accounts, instruments, valuation };
    }

    router.get('/holdings', async (req, res) => {
        const updating = market ? await market.refreshIfStale() || market.running : false;
        const [{ accounts, instruments, valuation }, status] = await Promise.all([valueAll(), data.marketStatus()]);
        page(req, res, 'Holdings', holdingsContent({ valuation, instruments, accounts, status, updating, csrf: req.session.csrf }));
    });

    // Waits for the update (up to a minute), then shows the holdings again
    router.post('/prices/update', form, async (req, res) => {
        if (!sameString(req.body?._csrf, req.session.csrf)) return forbidden(res);
        if (market) {
            let timer;
            await Promise.race([market.run().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 60_000); })]);
            clearTimeout(timer);
        }
        res.redirect(303, '/holdings');
    });

    router.get('/transactions', async (req, res) => {
        const { accounts, instruments, transactions } = await loadAll();
        const instrument = instruments.get(Number(req.query.instrument)) ?? null;
        const account = instrument ? null : accounts.get(Number(req.query.account)) ?? null;
        const rows = transactions
            .filter(t => (!instrument || t.instrumentId === instrument.id) && (!account || t.accountId === account.id))
            .map(t => ({ ...t, account: accounts.get(t.accountId), instrument: instruments.get(t.instrumentId) ?? null }));
        const title = instrument ? `${instrument.symbol} transactions` : account ? `${account.name} transactions` : 'Transactions';
        page(req, res, title, transactionsContent({ rows, instrument, account }));
    });

    // ── P2P accounts ────────────────────────────────────────────────────────

    router.get('/p2p', async (req, res) => {
        const { accounts, transactions } = await loadAll();
        page(req, res, 'P2P lending', p2pListContent({ summaries: await p2pSummaries(accounts, transactions) }));
    });

    const p2pAccount = async req => {
        const account = await data.getAccount(Number(req.params.id));
        return account?.kind === 'p2p' ? account : null;
    };

    router.get('/p2p/:id', async (req, res, next) => {
        const account = await p2pAccount(req);
        if (!account) return next();
        const [rows, balances] = await Promise.all([data.listTransactions({ accountId: account.id }), data.listBalances({ accountId: account.id })]);
        const summary = summariseP2p({ account, rows, balances, today: today() });
        page(req, res, account.name, p2pAccountContent({ summary, balances, csrf: req.session.csrf }));
    });

    router.get('/p2p/:id/balances/new', async (req, res, next) => {
        const account = await p2pAccount(req);
        if (!account) return next();
        page(req, res, 'Add a balance', balanceForm({ action: `/p2p/${account.id}/balances`, csrf: req.session.csrf, account, values: { date: today() } }));
    });

    router.post('/p2p/:id/balances', form, async (req, res, next) => {
        if (!checked(req, res)) return;
        const account = await p2pAccount(req);
        if (!account) return next();
        const { values, errors } = parseBalance(req.body, account.id);
        if (Object.keys(errors).length) {
            return page(req, res, 'Add a balance', balanceForm({ action: `/p2p/${account.id}/balances`, csrf: req.session.csrf, account, values: req.body, errors }), 400);
        }
        await data.saveBalance(values);
        res.redirect(303, `/p2p/${account.id}`);
    });

    router.post('/p2p/:id/balances/:date/delete', form, async (req, res, next) => {
        if (!checked(req, res)) return;
        const account = await p2pAccount(req);
        if (!account || !/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return next();
        await data.deleteBalance(account.id, req.params.date);
        res.redirect(303, `/p2p/${account.id}`);
    });

    // ── Overview ────────────────────────────────────────────────────────────

    router.get('/', async (req, res) => {
        const updating = market ? await market.refreshIfStale() || market.running : false;
        const [r, { accounts, instruments, valuation }, status, groups, holdings, transactions] = await Promise.all([
            reports(), valueAll(), data.marketStatus(), data.listGroups(), holdingsForAllocation(), data.listTransactions(),
        ]);
        const series = r.series();
        const total = series.length ? r.total() : null;
        const p2p = [...accounts.values()].filter(a => a.kind === 'p2p').map(account => ({
            account, lastDate: transactions.filter(t => t.accountId === account.id).at(-1)?.date ?? null,
        }));
        const notices = dashboardNotices({
            valuation, instruments, status, updating, p2p, today: today(),
            unassigned: groups.length ? holdings.filter(h => !groups.some(g => g.id === h.groupId)) : [],
            allocation: groups.length ? allocation({ groups, items: holdings }) : null,
        });
        const content = dashboardContent({
            total: valuation.total, year: series.length ? r.year(Number(today().slice(0, 4))) : null,
            series, income: r.income(), groups: total?.groups ?? null, notices,
            benchmark: series.length ? await compareWithBenchmark(series.map(p => p.date)) : null,
        });
        page(req, res, 'Overview', content, 200, series.length ? CHART_SCRIPTS : []);
    });

    // ── Benchmark ───────────────────────────────────────────────────────────

    // The chosen benchmark: { name, symbol, ...benchmark.js result } (result null
    // without prices yet), or null when none is chosen
    async function compareWithBenchmark(dates = []) {
        const settings = await data.settings();
        const instrument = settings.benchmark_instrument ? await data.getInstrument(Number(settings.benchmark_instrument)) : null;
        if (!instrument) return null;
        const [transactions, prices, rates] = await Promise.all([data.listTransactions(), data.listPrices(), data.listFxRates()]);
        const result = benchmark({
            transactions, prices: prices.filter(p => p.instrumentId === instrument.id), eurPer: createRates(rates), today: today(), dates,
        });
        return { name: instrument.priceSymbol ?? instrument.symbol, symbol: instrument.priceSymbol ?? instrument.symbol, result };
    }

    const SYMBOL = /^[A-Z0-9^][A-Z0-9.^=\-]{0,31}$/;

    // Choose the benchmark by its Yahoo Finance symbol, then fetch its prices (up to a minute)
    router.post('/benchmark', form, async (req, res) => {
        if (!checked(req, res)) return;
        const symbol = String(req.body?.symbol ?? '').trim().toUpperCase();
        if (!SYMBOL.test(symbol)) return res.redirect(303, '/reports?benchmark=invalid#benchmark-heading');
        const instruments = await data.listInstruments();
        let instrument = instruments.find(i => i.priceSymbol === symbol) ?? instruments.find(i => !i.priceSymbol && i.symbol === symbol);
        const id = instrument?.id ?? await data.createInstrument({
            symbol, name: `${symbol} (benchmark)`, isin: null, kind: 'etf', currency: 'EUR', distributing: null, assetClass: null,
            priceSymbol: symbol, priceSource: 'yahoo',
        });
        await data.setSetting('benchmark_instrument', String(id));
        if (market) {
            let timer;
            await Promise.race([market.run().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 60_000); })]);
            clearTimeout(timer);
        }
        res.redirect(303, '/reports#benchmark-heading');
    });

    // ── Reports ─────────────────────────────────────────────────────────────

    async function reports() {
        const [{ accounts, instruments, transactions }, prices, rates, balances, groups] = await Promise.all([
            loadAll(), data.listPrices(), data.listFxRates(), data.listBalances(), data.listGroups(),
        ]);
        return createReports({
            transactions, accounts, instruments, balances, groups,
            priceOf: createPrices(prices), eurPer: createRates(rates), today: today(),
        });
    }
    const download = (res, name, text) => {
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
        res.send(`\uFEFF${text}`);
    };

    router.get('/reports', async (req, res) => {
        const r = await reports();
        const total = r.firstDate ? { ...r.total(), firstDate: r.firstDate } : null;
        page(req, res, 'Reports', reportsContent({
            total, years: r.years.map(r.year), csrf: req.session.csrf,
            benchmark: total ? await compareWithBenchmark() : null, invalidSymbol: req.query.benchmark === 'invalid',
        }), 200, total ? CHART_SCRIPTS : []);
    });

    router.get('/reports.csv', async (req, res) => {
        const r = await reports();
        download(res, 'invest-years.csv', yearsCsv(r.years.map(r.year)));
    });

    // /reports/2025 and /reports/2025.csv
    router.get('/reports/:file', async (req, res, next) => {
        const match = req.params.file.match(/^(\d{4})(\.csv)?$/);
        if (!match) return next();
        const r = await reports();
        const year = Number(match[1]);
        if (!r.years.includes(year)) return next();
        const report = r.year(year);
        if (match[2]) return download(res, `invest-${year}.csv`, yearCsv(report));
        page(req, res, `Report ${year}`, yearContent({ report, years: r.years }), 200, report.groups.list.length ? CHART_SCRIPTS : []);
    });

    // ── Projection ──────────────────────────────────────────────────────────

    router.get('/projection', async (req, res) => {
        const r = await reports();
        const history = r.firstDate ? r.groupHistory() : [];
        const thisYear = Number(today().slice(0, 4));
        const keyOf = g => `rate-${g.id === null ? 'none' : g.id}`;
        // The first visit uses ten years, nothing more invested, and past returns
        const asked = req.query.years !== undefined;
        const values = { years: asked ? String(req.query.years) : '10', monthly: asked ? String(req.query.monthly ?? '') : '0' };
        for (const g of history) values[keyOf(g)] = asked ? String(req.query[keyOf(g)] ?? '') : g.xirr === null ? '0' : (g.xirr * 100).toFixed(1);

        const errors = {};
        const read = (name, min, max, message) => {
            try {
                const v = number(values[name]);
                if (v === null || v < BigInt(min) * 10n ** 8n || v > BigInt(max) * 10n ** 8n) throw new Error();
                return Number(fixed(v, 4));
            } catch {
                errors[name] = message;
                return null;
            }
        };
        const years = read('years', 1, 50, 'Enter a whole number of years from 1 to 50.');
        if (years !== null && !Number.isInteger(years)) errors.years = 'Enter a whole number of years from 1 to 50.';
        const monthly = read('monthly', 0, 10_000_000, 'Enter an amount, or 0.');
        const rates = history.map(g => read(keyOf(g), -50, 50, 'Enter a percentage from −50 to 50, like 7.'));

        // The monthly amount goes by the targets when they're set, otherwise by today's values
        const targeted = history.some(g => g.targetPct !== null)
            && history.filter(g => g.targetPct !== null).reduce((sum, g) => sum + Number(g.targetPct), 0) === 100;
        const weightOf = g => (targeted ? (g.targetPct === null ? 0 : Number(g.targetPct)) : Number(fixed(g.value ?? 0n)));
        const split = !history.length ? '' : targeted
            ? `by your targets: ${history.filter(g => g.targetPct !== null).map(g => `${g.name} ${Number(g.targetPct)}%`).join(', ')}`
            : 'in proportion to what each group is worth now';

        const projection = Object.keys(errors).length || !history.length ? null : project({
            years, monthlyAmount: monthly,
            groups: history.map((g, i) => ({
                id: g.id, name: g.name, value: Number(fixed(g.value ?? 0n)), rate: rates[i] / 100,
                spread: spreadOf(g.years.map(y => y.rate)), weight: weightOf(g),
            })),
        });
        page(req, res, 'Projection', projectionContent({ history, values, errors, projection, split, thisYear }),
            Object.keys(errors).length ? 400 : 200, projection ? CHART_SCRIPTS : []);
    });

    // ── Tax summary ─────────────────────────────────────────────────────────

    // /tax: the last whole year (or this one, in the first year)
    router.get('/tax', async (req, res) => {
        const first = (await data.listTransactions())[0]?.date;
        const year = Number(today().slice(0, 4));
        res.redirect(303, `/tax/${first && Number(first.slice(0, 4)) < year ? year - 1 : year}`);
    });

    // /tax/2025 and /tax/2025.csv, with ?rate=15 for the tax on interest in percent
    router.get('/tax/:file', async (req, res, next) => {
        const match = req.params.file.match(/^(\d{4})(\.csv)?$/);
        if (!match) return next();
        const year = Number(match[1]);
        const [{ accounts, instruments, transactions }, rates] = await Promise.all([loadAll(), data.listFxRates()]);
        const firstYear = transactions[0] ? Number(transactions[0].date.slice(0, 4)) : null;
        const thisYear = Number(today().slice(0, 4));
        if (firstYear === null || year < firstYear || year > thisYear) return next();

        // Percentages from the form, as decimals: 15 → 0.15
        const errors = {};
        const percentage = (name, fallback, standard) => {
            const text = String(req.query[name] ?? fallback).trim();
            try {
                const pct = number(text);
                if (pct === null || pct < 0n || pct > 100n * 10n ** 8n) throw new Error();
                return { text, rate: pct / 100n };
            } catch {
                errors[name] = 'Enter a percentage from 0 to 100, like 15.';
                return { text, rate: standard };
            }
        };
        const { text: rateText, rate } = percentage('rate', '15', DEFAULT_RATE);
        const { text: dividendRateText, rate: dividendRate } = percentage('dividendRate', '5', DEFAULT_DIVIDEND_RATE);
        const t = taxYear({ transactions, accounts, instruments, eurPer: createRates(rates), year, rate, dividendRate });
        if (match[2]) return download(res, `invest-tax-${year}.csv`, taxCsv(t));
        const years = Array.from({ length: thisYear - firstYear + 1 }, (_, i) => thisYear - i);
        const failed = Object.keys(errors).length > 0;
        page(req, res, `Tax summary ${year}`, taxContent({ t, years, rateText, dividendRateText, errors }), failed ? 400 : 200);
    });

    // ── Export ──────────────────────────────────────────────────────────────

    const stamp = () => new Date(now()).toISOString().slice(0, 10);

    router.get('/export', async (req, res) => {
        const [accounts, transactions, prices] = await Promise.all([data.listAccounts(), data.listTransactions(), data.listPrices()]);
        page(req, res, 'Export your data', exportContent({ counts: { accounts: accounts.length, transactions: transactions.length, prices: prices.length } }));
    });

    router.get('/export/backup.json', async (req, res) => {
        res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="invest-backup-${stamp()}.json"` });
        res.send(JSON.stringify(await backup(data, new Date(now())), null, 1));
    });

    router.get('/export/transactions.csv', async (req, res) => download(res, `invest-transactions-${stamp()}.csv`, await transactionsCsv(data)));

    // ── Allocation ──────────────────────────────────────────────────────────

    // What can be in a group: open positions and P2P accounts, valued today
    async function holdingsForAllocation() {
        const { accounts, instruments, valuation } = await valueAll();
        const positions = valuation.positions.filter(p => p.open).map(p => {
            const i = instruments.get(p.instrument);
            return { key: `i${i.id}`, name: i.symbol, groupId: i.allocationGroupId ?? null, valueEur: p.valueEur };
        });
        const p2p = [...accounts.values()].filter(a => a.kind === 'p2p').map(a => ({
            key: `a${a.id}`, name: a.name, groupId: a.allocationGroupId ?? null,
            valueEur: valuation.cash.filter(b => Number(b.account) === a.id).reduce((sum, b) => (sum === null || b.valueEur === null ? null : sum + b.valueEur), 0n),
        }));
        return [...positions.sort((a, b) => a.name.localeCompare(b.name)), ...p2p];
    }

    router.get('/allocation', async (req, res) => {
        const [groups, holdings] = await Promise.all([data.listGroups(), holdingsForAllocation()]);
        const text = String(req.query.amount ?? '').trim();
        let amount = null;
        let error = '';
        if (text) {
            try {
                amount = number(text);
                if (amount <= 0n) throw new Error();
            } catch {
                amount = null;
                error = 'Enter an amount above zero, like 500.';
            }
        }
        page(req, res, 'Allocation', allocationContent({ result: allocation({ groups, items: holdings, amount }), amount: text, error }), error ? 400 : 200);
    });

    router.get('/allocation/edit', async (req, res) => {
        const [groups, holdings] = await Promise.all([data.listGroups(), holdingsForAllocation()]);
        page(req, res, 'Groups and targets', allocationForm({ groups, holdings, csrf: req.session.csrf }));
    });

    router.post('/allocation', form, async (req, res) => {
        if (!checked(req, res)) return;
        const [groups, holdings] = await Promise.all([data.listGroups(), holdingsForAllocation()]);
        const { values, errors } = parseAllocation(req.body, { groups, holdings });
        if (Object.keys(errors).length) {
            return page(req, res, 'Groups and targets', allocationForm({ groups, holdings, values: req.body, errors, csrf: req.session.csrf }), 400);
        }
        await data.saveAllocation(values);
        res.redirect(303, '/allocation');
    });

    // ── Adding and editing transactions ─────────────────────────────────────

    const choices = async () => ({ accounts: await data.listAccounts(), instruments: await data.listInstruments() });
    const id = req => Number(req.params.id);
    const checked = (req, res) => {
        if (sameString(req.body?._csrf, req.session.csrf)) return true;
        forbidden(res);
        return false;
    };
    const backTo = t => (t.instrumentId ? `/transactions?instrument=${t.instrumentId}` : '/transactions');

    router.get('/transactions/new', async (req, res) => {
        const { accounts, instruments } = await choices();
        if (!accounts.length) return res.redirect(303, '/accounts/new');
        const instrument = instruments.find(i => i.id === Number(req.query.instrument));
        page(req, res, 'Add a transaction', transactionForm({
            action: '/transactions', csrf: req.session.csrf, accounts, instruments,
            values: { type: 'buy', date: today(), account: String(accounts[0].id), instrument: instrument ? String(instrument.id) : '', currency: instrument?.currency ?? 'EUR' },
        }));
    });

    router.post('/transactions', form, async (req, res) => {
        if (!checked(req, res)) return;
        const { accounts, instruments } = await choices();
        const { values, errors } = parseTransaction(req.body, { accounts, instruments });
        if (Object.keys(errors).length) {
            return page(req, res, 'Add a transaction', transactionForm({ action: '/transactions', csrf: req.session.csrf, accounts, instruments, values: req.body, errors }), 400);
        }
        await data.createTransaction(values);
        res.redirect(303, backTo(values));
    });

    router.get('/transactions/:id/edit', async (req, res, next) => {
        const transaction = await data.getTransaction(id(req));
        if (!transaction) return next();
        const { accounts, instruments } = await choices();
        page(req, res, 'Edit transaction', transactionForm({
            action: `/transactions/${transaction.id}`, csrf: req.session.csrf, accounts, instruments, transaction, values: transactionFields(transaction),
        }));
    });

    router.post('/transactions/:id', form, async (req, res, next) => {
        if (!checked(req, res)) return;
        const transaction = await data.getTransaction(id(req));
        if (!transaction) return next();
        const { accounts, instruments } = await choices();
        const { values, errors } = parseTransaction(req.body, { accounts, instruments });
        if (Object.keys(errors).length) {
            return page(req, res, 'Edit transaction', transactionForm({
                action: `/transactions/${transaction.id}`, csrf: req.session.csrf, accounts, instruments, transaction, values: req.body, errors,
            }), 400);
        }
        await data.updateTransaction(transaction.id, values);
        res.redirect(303, backTo(values));
    });

    router.get('/transactions/:id/delete', async (req, res, next) => {
        const transaction = await data.getTransaction(id(req));
        if (!transaction) return next();
        const instrument = transaction.instrumentId ? await data.getInstrument(transaction.instrumentId) : null;
        const description = [transaction.date, TYPE_LABELS[transaction.type], instrument?.symbol,
            transaction.units && `${Number(transaction.units)} units`, `${Number(transaction.amount)} ${transaction.currency}`].filter(Boolean).join(', ');
        page(req, res, 'Delete transaction', deleteTransactionContent({ transaction, csrf: req.session.csrf, description }));
    });

    router.post('/transactions/:id/delete', form, async (req, res, next) => {
        if (!checked(req, res)) return;
        const transaction = await data.getTransaction(id(req));
        if (!transaction) return next();
        await data.deleteTransaction(transaction.id);
        res.redirect(303, backTo(transaction));
    });

    // ── Instruments ─────────────────────────────────────────────────────────

    const DUPLICATE_ISIN = { isin: 'Another instrument already has this ISIN.' };
    const saveInstrument = async (req, res, { save, title, action, editing }) => {
        const { values, errors } = parseInstrument(req.body);
        const again = extra => page(req, res, title, instrumentForm({ action, csrf: req.session.csrf, values: req.body, errors: { ...errors, ...extra }, editing }), 400);
        if (Object.keys(errors).length) return again();
        try {
            await save(values);
        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY') return again(DUPLICATE_ISIN);
            throw err;
        }
        res.redirect(303, '/instruments');
    };

    router.get('/instruments', async (req, res) => page(req, res, 'Instruments', instrumentsContent({ instruments: await data.listInstruments() })));
    router.get('/instruments/new', (req, res) => page(req, res, 'Add an instrument', instrumentForm({
        action: '/instruments', csrf: req.session.csrf, values: { kind: 'etf', currency: 'EUR' },
    })));
    router.post('/instruments', form, async (req, res) => {
        if (!checked(req, res)) return;
        await saveInstrument(req, res, { save: data.createInstrument, title: 'Add an instrument', action: '/instruments' });
    });
    router.get('/instruments/:id/edit', async (req, res, next) => {
        const instrument = await data.getInstrument(id(req));
        if (!instrument) return next();
        page(req, res, 'Edit instrument', instrumentForm({
            action: `/instruments/${instrument.id}`, csrf: req.session.csrf, values: instrumentFields(instrument), editing: true,
        }));
    });
    router.post('/instruments/:id', form, async (req, res, next) => {
        if (!checked(req, res)) return;
        const instrument = await data.getInstrument(id(req));
        if (!instrument) return next();
        await saveInstrument(req, res, {
            save: values => data.updateInstrument(instrument.id, values), title: 'Edit instrument', action: `/instruments/${instrument.id}`, editing: true,
        });
    });

    // ── Accounts ────────────────────────────────────────────────────────────

    router.get('/accounts', async (req, res) => page(req, res, 'Accounts', accountsContent({ accounts: await data.listAccounts() })));
    router.get('/accounts/new', (req, res) => page(req, res, 'Add an account', accountForm({
        action: '/accounts', csrf: req.session.csrf, values: { kind: 'broker', baseCurrency: 'EUR' },
    })));
    router.post('/accounts', form, async (req, res) => {
        if (!checked(req, res)) return;
        const { values, errors } = parseAccount(req.body);
        if (Object.keys(errors).length) {
            return page(req, res, 'Add an account', accountForm({ action: '/accounts', csrf: req.session.csrf, values: req.body, errors }), 400);
        }
        await data.createAccount(values);
        res.redirect(303, '/accounts');
    });
    router.get('/accounts/:id/edit', async (req, res, next) => {
        const account = await data.getAccount(id(req));
        if (!account) return next();
        page(req, res, 'Edit account', accountForm({
            action: `/accounts/${account.id}`, csrf: req.session.csrf, values: accountFields(account), editing: true,
        }));
    });
    router.post('/accounts/:id', form, async (req, res, next) => {
        if (!checked(req, res)) return;
        const account = await data.getAccount(id(req));
        if (!account) return next();
        const { values, errors } = parseAccount(req.body);
        if (Object.keys(errors).length) {
            return page(req, res, 'Edit account', accountForm({ action: `/accounts/${account.id}`, csrf: req.session.csrf, values: req.body, errors, editing: true }), 400);
        }
        await data.updateAccount(account.id, values);
        res.redirect(303, '/accounts');
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
        const files = (parsed.uploads.statement ?? []).filter(f => f.data.length);
        if (!files.length) return fail('Choose a statement file to upload.');

        let statement;
        try {
            statement = parseStatement(files.map(f => f.data));
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
        page(req, res, 'Import finished', doneContent({
            added, changed: plan.updates?.length ?? 0, account: plan.account.name,
            next: plan.kind === 'p2p' ? '/p2p' : '/holdings',
        }));
    });

    return router;
}
