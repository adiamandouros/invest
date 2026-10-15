import { createHash } from 'crypto';
import { fixed } from '../lib/decimal.js';

// Builds a P2P statement for server/import/index.js from a platform's rows
// (server/import/mintos.js, peerberry.js), one or more files' worth:
//
//   { platform, kind: 'p2p', accountRef: null, accountName, baseCurrency, openedOn,
//     period: { start, end },
//     transactions: [{ ref, type, date, amount, currency, notes, month, key, ... }],
//     balances: [{ date, cash, currency }],
//     check: { currency: { opening, turnover, closing } },
//     warnings: [] }
//
// Platforms list every loan's interest and repayment on its own row, so
// those are added up per month: one row each for interest, tax and fees, with
// the ref "<platform>:<currency>:<YYYY-MM>:<key>". Deposits and withdrawals
// stay one row each, by the platform's ID. Investments and repayments only move
// money between cash and loans inside the account, so they aren't in the
// ledger: the ledger's sum is the account's value, cash plus loans at nominal value.
//
// Rows: { id, at (sortable date and time), date, amount (decimal), currency,
// kind: deposit | withdrawal | interest | bonus | tax | fee | internal | null,
// label (the platform's name for the type), balance (the cash after it, or null) }.
// Rows with the same id (overlapping files) count once.

const TYPES = { interest: 'interest', bonus: 'interest', tax: 'tax', fee: 'fee' };
const LABELS = { interest: 'interest', bonus: 'bonuses', tax: 'tax withheld', fee: 'fees' };
const money = value => fixed(value, 6).replace(/\.?0+$/, '') || '0';

export function p2pStatement({ platform, name, rows: all }) {
    // import_ref holds 100 characters
    const idRef = id => (id.length + platform.length < 99 ? `${platform}:${id}` : `${platform}:sha1:${createHash('sha1').update(id).digest('hex')}`);
    const byId = new Map();
    for (const r of all) if (!byId.has(r.id)) byId.set(r.id, r);
    const rows = [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order));
    if (!rows.length) throw new Error('The statement has no rows');

    const warnings = [];
    const transactions = [];
    const groups = new Map();
    const check = {};
    const monthEnds = new Map();
    const unknown = new Map();
    for (const r of rows) {
        // Where the statement gives the cash after each row, the cash before its first row;
        // otherwise the running cash from the first row (an account the app has nothing from yet starts at 0)
        const known = r.balance !== null && r.balance !== undefined;
        check[r.currency] ??= { opening: known ? r.balance - r.amount : null, turnover: 0n, closing: null };
        const c = check[r.currency];
        c.turnover += r.amount;
        c.closing = known ? r.balance : null;
        monthEnds.set(`${r.currency}|${r.date.slice(0, 7)}`, {
            date: r.date, currency: r.currency, cash: known ? money(r.balance) : null, running: c.turnover,
        });

        if (r.kind === 'internal') continue;
        if (r.kind === 'deposit' || r.kind === 'withdrawal') {
            transactions.push({ ref: idRef(r.id), type: r.kind, date: r.date, amount: money(r.amount), currency: r.currency, notes: `${name} ${r.label.toLowerCase()}` });
            continue;
        }
        if (!TYPES[r.kind]) {
            const u = unknown.get(r.label) ?? { count: 0, total: 0n, currency: r.currency };
            u.count++;
            u.total += r.amount;
            unknown.set(r.label, u);
            continue;
        }
        const month = r.date.slice(0, 7);
        const ref = `${platform}:${r.currency}:${month}:${r.kind}`;
        const g = groups.get(ref) ?? { ref, kind: r.kind, month, currency: r.currency, date: r.date, amount: 0n, count: 0, labels: new Set() };
        g.amount += r.amount;
        g.count++;
        g.date = r.date;
        g.labels.add(r.label);
        groups.set(ref, g);
    }
    for (const [label, u] of unknown) {
        warnings.push(`${u.count} row${u.count === 1 ? '' : 's'} of "${label}" (${fixed(u.total)} ${u.currency} in all) not imported: the app doesn't know this payment type yet`);
    }
    for (const g of groups.values()) {
        transactions.push({
            ref: g.ref, type: TYPES[g.kind], date: g.date, amount: money(g.amount), currency: g.currency, month: g.month, key: g.kind,
            notes: `${name} ${LABELS[g.kind]} for ${g.month}, the sum of ${g.count} statement row${g.count === 1 ? '' : 's'}: ${[...g.labels].join(', ')}`.slice(0, 500),
        });
    }
    transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const currencies = Object.keys(check);
    return {
        platform,
        kind: 'p2p',
        accountRef: null,
        accountName: name,
        baseCurrency: currencies.includes('EUR') ? 'EUR' : currencies[0],
        openedOn: null,
        period: { start: rows[0].date, end: rows.at(-1).date },
        transactions: transactions.map(t => ({ instrumentKey: null, units: null, price: null, fee: '0', feeCurrency: null, fxToEur: t.currency === 'EUR' ? '1' : null, ...t })),
        balances: [...monthEnds.values()],
        check,
        warnings,
    };
}

