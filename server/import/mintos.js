import { createHash } from 'crypto';
import { dec, fixed } from '../lib/decimal.js';

// Reads a Mintos account statement (Account → Account statement, exported as
// CSV) into a P2P statement for server/import/index.js:
//
//   { platform, kind: 'p2p', accountRef: null, accountName, baseCurrency,
//     period: { start, end },
//     transactions: [{ ref, type, date, amount, currency, notes, month, key, ... }],
//     balances: [{ date, cash, currency }],
//     check: { currency: { opening, turnover, closing } },
//     warnings: [] }
//
// Mintos lists every loan's interest, tax and repayment on its own row (tens of
// thousands a year), so those are added up per month: one row each for
// interest, tax and fees, with the ref "mintos:<currency>:<YYYY-MM>:<key>".
// Deposits and withdrawals stay one row each, by Mintos's transaction ID.
// Investments and repayments only move money between cash and loans inside
// the account, so they aren't in the ledger: the ledger's sum is the account's
// value, cash plus loans at their nominal value.

const HEADER = ['Date', 'Transaction ID:', 'Details', 'Turnover', 'Balance', 'Currency', 'Payment Type'];

// Payment type → what it is. Checked in order; anything else is reported.
const KINDS = [
    [/^deposits?$/i, 'deposit'],
    [/^withdrawals?$/i, 'withdrawal'],
    [/^tax withholding/i, 'tax'],
    [/fee$/i, 'fee'],
    [/^(investment|principal received|secondary market transaction)/i, 'internal'],
    [/^(interest received|delayed interest income|late fees received)/i, 'interest'],
    [/(bonus|reward|cashback|referral)/i, 'bonus'],
];
const TYPES = { interest: 'interest', bonus: 'interest', tax: 'tax', fee: 'fee' };
const LABELS = { interest: 'interest', bonus: 'bonuses', tax: 'tax withheld', fee: 'fees' };

export const isMintos = text => {
    const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0];
    return csvRows(first)[0]?.join('|') === HEADER.join('|');
};

// RFC 4180: commas, "quoted, fields" and "" for a quote inside one
export function csvRows(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else field += c;
    }
    if (field || row.length) rows.push([...row, field]);
    return rows.filter(r => r.some(f => f !== ''));
}

// import_ref holds 100 characters; Mintos's IDs are about 60, but just in case
const idRef = id => (id.length <= 90 ? `mintos:${id}` : `mintos:sha1:${createHash('sha1').update(id).digest('hex')}`);
const kindOf = paymentType => KINDS.find(([pattern]) => pattern.test(paymentType))?.[1] ?? null;
const money = value => fixed(value, 6).replace(/\.?0+$/, '') || '0';

export function parseMintos(text) {
    const [header, ...lines] = csvRows(text.replace(/^﻿/, ''));
    if (header?.join('|') !== HEADER.join('|')) throw new Error('This isn\'t a Mintos account statement in CSV format');
    const warnings = [];
    const rows = lines.map((cells, index) => {
        const [date, id, details, turnover, balance, currency, paymentType] = cells;
        if (!/^\d{4}-\d{2}-\d{2}/.test(date ?? '') || !/^[A-Z]{3}$/.test(currency ?? '')) {
            throw new Error(`Row ${index + 2} of the statement can't be read: expected a date and a currency`);
        }
        return { index, date: date.slice(0, 10), id, details, turnover: dec(turnover), balance: dec(balance), currency, paymentType };
    });
    if (!rows.length) throw new Error('The statement has no rows');
    // Mintos lists the oldest first; sorted anyway, keeping the order within a second
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.index - b.index));

    const transactions = [];
    const groups = new Map();
    const check = {};
    const monthEnds = new Map();
    const unknown = new Map();
    for (const r of rows) {
        // The cash before the statement's first row, then each row's change
        check[r.currency] ??= { opening: r.balance - r.turnover, turnover: 0n, closing: null };
        check[r.currency].turnover += r.turnover;
        check[r.currency].closing = r.balance;
        const month = r.date.slice(0, 7);
        monthEnds.set(`${r.currency}|${month}`, { date: r.date, cash: money(r.balance), currency: r.currency });

        const kind = kindOf(r.paymentType);
        if (kind === 'internal') continue;
        if (kind === 'deposit' || kind === 'withdrawal') {
            transactions.push({
                ref: idRef(r.id), type: kind, date: r.date, amount: money(r.turnover), currency: r.currency,
                notes: `Mintos ${r.paymentType.toLowerCase()}`,
            });
            continue;
        }
        if (!kind) {
            const u = unknown.get(r.paymentType) ?? { count: 0, total: 0n, currency: r.currency };
            u.count++;
            u.total += r.turnover;
            unknown.set(r.paymentType, u);
            continue;
        }
        const ref = `mintos:${r.currency}:${month}:${kind}`;
        const g = groups.get(ref) ?? { ref, kind, month, currency: r.currency, date: r.date, amount: 0n, count: 0, types: new Set() };
        g.amount += r.turnover;
        g.count++;
        g.date = r.date;
        g.types.add(r.paymentType);
        groups.set(ref, g);
    }
    for (const [paymentType, u] of unknown) {
        warnings.push(`${u.count} row${u.count === 1 ? '' : 's'} of "${paymentType}" (${fixed(u.total)} ${u.currency} in all) not imported: the app doesn't know this payment type yet`);
    }
    for (const g of groups.values()) {
        transactions.push({
            ref: g.ref, type: TYPES[g.kind], date: g.date, amount: money(g.amount), currency: g.currency, month: g.month, key: g.kind,
            notes: `Mintos ${LABELS[g.kind]} for ${g.month}, the sum of ${g.count} statement row${g.count === 1 ? '' : 's'}: ${[...g.types].join(', ')}`.slice(0, 500),
        });
    }
    transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const currencies = Object.keys(check);
    return {
        platform: 'mintos',
        kind: 'p2p',
        accountRef: null,
        accountName: 'Mintos',
        baseCurrency: currencies.includes('EUR') ? 'EUR' : currencies[0],
        openedOn: null,
        period: { start: rows[0].date, end: rows.at(-1).date },
        transactions: transactions.map(t => ({ instrumentKey: null, units: null, price: null, fee: '0', feeCurrency: null, fxToEur: t.currency === 'EUR' ? '1' : null, ...t })),
        balances: [...monthEnds.values()],
        check,
        warnings,
    };
}
