import { dec, fixed, plain } from '../lib/decimal.js';
import { cash, positions } from '../lib/holdings.js';
import { isFreedom24, parseFreedom24 } from './freedom24.js';
import { isMintos, parseMintos } from './mintos.js';
import { isPeerberry, parsePeerberry } from './peerberry.js';
import { isXlsx, readXlsx } from './xlsx.js';

// Importing a statement in two steps: planImport works out what's new
// and checks the result against the statement's closing balances, without
// writing anything; applyImport writes that plan in one database transaction.
// `data` is server/data/store.js.

const UNKNOWN = 'isn\'t a statement the app can read yet: a Freedom24 broker report (JSON), Mintos account statements (CSV) or PeerBerry transactions (Excel).';

// Which platform a file is from: 'freedom24' (with the parsed report), 'mintos' or 'peerberry'
function identify(file, name) {
    if (isXlsx(file)) {
        let rows;
        try {
            rows = readXlsx(file);
        } catch {
            rows = [];
        }
        if (isPeerberry(rows)) return { platform: 'peerberry' };
        throw new Error(`${name} ${UNKNOWN}`);
    }
    const text = Buffer.isBuffer(file) ? file.toString('utf8') : file;
    if (isMintos(text)) return { platform: 'mintos', text };
    try {
        const report = JSON.parse(text);
        if (isFreedom24(report)) return { platform: 'freedom24', report };
    } catch {
        // not JSON either
    }
    throw new Error(`${name} ${UNKNOWN}`);
}

// One file (text or Buffer) or several from the same P2P platform, read as one statement
export function parseStatement(input) {
    const files = [input].flat();
    const found = files.map((file, i) => identify(file, files.length > 1 ? `File ${i + 1}` : 'This file'));
    const platforms = new Set(found.map(f => f.platform));
    if (platforms.size > 1) throw new Error('These files are from different platforms. Import one platform\'s files at a time.');
    const [platform] = platforms;
    if (platform === 'freedom24') {
        if (found.length > 1) throw new Error('Import one Freedom24 report at a time.');
        return parseFreedom24(found[0].report);
    }
    if (platform === 'mintos') return parseMintos(found.map(f => f.text));
    return parsePeerberry(files);
}

const keyOf = instrument => instrument.isin ?? instrument.symbol;

export async function planImport(statement, data) {
    if (statement.kind === 'p2p') return planP2pImport(statement, data);
    const account = await data.findAccount(statement.platform, statement.accountRef);
    const known = await data.listInstruments();
    const existing = account ? await data.listTransactions({ accountId: account.id }) : [];

    // Statement instruments that are already in the app, by ISIN or else by symbol
    const instrumentIds = {};
    const newInstruments = [];
    for (const i of statement.instruments) {
        const match = known.find(k => (i.isin ? k.isin === i.isin : !k.isin && k.symbol === i.symbol));
        if (match) instrumentIds[i.key] = match.id;
        else newInstruments.push(i);
    }
    const keyById = new Map(known.map(k => [k.id, keyOf(k)]));

    // Everything as ledger rows with instrument keys, so old and new can be added up together
    const asRow = t => ({ ...t, account: 'a', instrument: t.instrumentKey ?? null });
    const existingRows = existing.map(t => asRow({ ...t, instrumentKey: t.instrumentId ? keyById.get(t.instrumentId) : null }));
    const refs = new Set(existing.map(t => t.importRef));
    const transactions = statement.transactions.filter(t => !refs.has(t.ref));

    // Positions and cash the statement starts with but the app doesn't have yet
    // (shares bought before the statement's period): added as opening rows
    const before = rows => rows.filter(r => r.date <= statement.period.start);
    const heldBefore = positions(before(existingRows));
    const cashBefore = cash(before(existingRows));
    for (const [key, { units, price }] of Object.entries(statement.opening.positions)) {
        const missing = dec(units) - (heldBefore.get(key)?.units ?? 0n);
        const ref = `opening:${key}:${statement.period.start}`;
        if (missing > 0n && !refs.has(ref)) {
            const currency = statement.instruments.find(i => i.key === key)?.currency ?? statement.baseCurrency;
            transactions.push({
                ref, instrumentKey: key, type: 'shares_in', date: statement.period.start, units: plain(missing), price,
                amount: '0', currency, fee: '0', feeCurrency: null, fxToEur: currency === 'EUR' ? '1' : null,
                notes: 'Held at the start of the statement; the cost is what the broker reported',
            });
        }
    }
    for (const [currency, amount] of Object.entries(statement.opening.cash)) {
        const missing = dec(amount) - (cashBefore.get(`a|${currency}`) ?? 0n);
        const ref = `opening-cash:${currency}:${statement.period.start}`;
        if (missing !== 0n && !refs.has(ref)) {
            transactions.push({
                ref, instrumentKey: null, type: missing > 0n ? 'transfer_in' : 'transfer_out', date: statement.period.start,
                units: null, price: null, amount: fixed(missing, 8), currency, fee: '0', feeCurrency: null,
                fxToEur: currency === 'EUR' ? '1' : null, notes: 'Cash at the start of the statement',
            });
        }
    }

    // Check: with this import, does the app agree with the statement's closing balances?
    const upToEnd = [...existingRows, ...transactions.map(asRow)].filter(r => r.date <= statement.period.end);
    const held = positions(upToEnd);
    const balances = cash(upToEnd);
    const name = key => statement.instruments.find(i => i.key === key)?.symbol ?? key;
    const check = [
        ...Object.entries(statement.closing.cash).map(([currency, expected]) => {
            const computed = balances.get(`a|${currency}`) ?? 0n;
            return { label: `Cash ${currency}`, expected: fixed(dec(expected)), computed: fixed(computed), ok: fixed(dec(expected)) === fixed(computed) };
        }),
        ...[...new Set([...Object.keys(statement.closing.positions), ...[...held].filter(([, p]) => p.units !== 0n).map(([k]) => k)])]
            .map(key => {
                const expected = dec(statement.closing.positions[key] ?? '0');
                const computed = held.get(key)?.units ?? 0n;
                return { label: name(key), expected: plain(expected), computed: plain(computed), ok: expected === computed };
            }),
    ];

    const counts = {};
    for (const t of transactions) counts[t.type] = (counts[t.type] ?? 0) + 1;

    return {
        account: account ?? { id: null, name: statement.accountName, platform: statement.platform, externalRef: statement.accountRef },
        accountFields: { name: statement.accountName, kind: 'broker', platform: statement.platform, externalRef: statement.accountRef, baseCurrency: statement.baseCurrency, openedOn: statement.openedOn },
        period: statement.period,
        instrumentIds,
        newInstruments,
        transactions,
        counts,
        duplicates: statement.transactions.length - transactions.filter(t => !t.ref.startsWith('opening')).length,
        warnings: statement.warnings,
        check,
        checkOk: check.every(c => c.ok),
    };
}

// A P2P statement's monthly sums (server/import/p2p.js) are added, or
// replace what an earlier import gave for that month when this statement has
// the whole month; a month only partly in the statement doesn't replace one
// already imported. Checked against the statement's cash balance, or, where
// it has none (PeerBerry), against the cash worked out from the first row on.
const lastDay = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const monthName = month => new Date(`${month}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

async function planP2pImport(statement, data) {
    const account = await data.findAccount(statement.platform, statement.accountRef);
    const existing = account ? await data.listTransactions({ accountId: account.id }) : [];
    const byRef = new Map(existing.filter(t => t.importRef).map(t => [t.importRef, t]));
    const { start, end } = statement.period;
    const whole = month => start <= `${month}-01` && end >= lastDay(month);

    const transactions = [];
    const updates = [];
    const kept = new Set();
    let duplicates = 0;
    for (const t of statement.transactions) {
        const old = byRef.get(t.ref);
        if (!old) transactions.push(t);
        else if (dec(old.amount) === dec(t.amount)) duplicates++;
        else if (t.month && whole(t.month)) updates.push({ id: old.id, amount: t.amount, date: t.date, notes: t.notes, type: t.type });
        else {
            duplicates++;
            if (t.month) kept.add(t.month);
        }
    }
    const warnings = [...statement.warnings, ...[...kept].sort().map(m =>
        `${monthName(m)} is only partly in this statement and was imported before with other amounts, so the app keeps those. To update it, export a statement that starts on the 1st of the month.`)];

    const changed = new Map(updates.map(u => [u.id, u.amount]));
    const after = [...existing.map(t => ({ ...t, amount: changed.get(t.id) ?? t.amount })), ...transactions]
        .filter(t => t.date <= end).map(t => ({ ...t, account: 'a' }));
    const values = cash(after);
    // Without balances in the statement, the cash is known only when the app has nothing from before it
    const fromTheStart = !existing.some(t => t.date < start);
    const check = [];
    const openings = {};
    for (const [currency, c] of Object.entries(statement.check)) {
        const opening = c.opening ?? (fromTheStart ? 0n : null);
        openings[currency] = opening;
        const worked = opening === null ? null : opening + c.turnover;
        if (c.closing !== null) {
            // The statement's rows add up to its closing cash
            check.push({ label: `Cash ${currency} on ${end}`, expected: fixed(c.closing), computed: fixed(worked), ok: fixed(c.closing) === fixed(worked) });
        } else if (worked !== null) {
            check.push({ label: `Cash ${currency} on ${end}, worked out`, expected: 'not negative', computed: fixed(worked), ok: worked >= 0n });
        } else {
            warnings.push(`The ${currency} cash can't be worked out, because this statement has no balances and the app has rows from before it. The import is fine, but to check it, import all the files from the first deposit on together.`);
            continue;
        }
        // The ledger is the account's value: with this import it can't be less than the cash
        const closing = c.closing ?? worked;
        const value = values.get(`a|${currency}`) ?? 0n;
        check.push({
            label: `Money in loans (${currency}, value minus cash)`, expected: 'not negative', computed: fixed(value - closing),
            ok: value - closing >= 0n,
        });
    }

    const counts = {};
    for (const t of transactions) counts[t.type] = (counts[t.type] ?? 0) + 1;
    return {
        kind: 'p2p',
        account: account ?? { id: null, name: statement.accountName, platform: statement.platform, externalRef: statement.accountRef },
        accountFields: { name: statement.accountName, kind: 'p2p', platform: statement.platform, externalRef: statement.accountRef, baseCurrency: statement.baseCurrency, openedOn: start },
        period: statement.period,
        instrumentIds: {},
        newInstruments: [],
        transactions,
        updates,
        balances: statement.balances
            .map(b => ({ date: b.date, cash: b.cash ?? (openings[b.currency] == null ? null : fixed(openings[b.currency] + b.running, 6)) }))
            .filter(b => b.cash !== null),
        counts,
        duplicates,
        warnings,
        check,
        checkOk: check.every(c => c.ok),
    };
}

export const applyImport = (plan, data) => data.importStatement({
    account: plan.account.id ? { id: plan.account.id } : plan.accountFields,
    instrumentIds: plan.instrumentIds,
    instruments: plan.newInstruments,
    transactions: plan.transactions,
    updates: plan.updates ?? [],
    balances: plan.balances ?? [],
});
