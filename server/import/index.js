import { dec, fixed, plain } from '../lib/decimal.js';
import { cash, positions } from '../lib/holdings.js';
import { isFreedom24, parseFreedom24 } from './freedom24.js';

// Importing a broker statement in two steps: planImport works out what's new
// and checks the result against the statement's closing balances, without
// writing anything; applyImport writes that plan in one database transaction.
// `data` is server/data/store.js.

export function parseStatement(text) {
    let report;
    try {
        report = JSON.parse(text);
    } catch {
        throw new Error('The file isn\'t valid JSON. Export the report from Freedom24 as JSON.');
    }
    if (isFreedom24(report)) return parseFreedom24(report);
    throw new Error('This file isn\'t a statement the app can read yet. Only Freedom24 broker reports (JSON) are supported.');
}

const keyOf = instrument => instrument.isin ?? instrument.symbol;

export async function planImport(statement, data) {
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

export const applyImport = (plan, data) => data.importStatement({
    account: plan.account.id ? { id: plan.account.id } : plan.accountFields,
    instrumentIds: plan.instrumentIds,
    instruments: plan.newInstruments,
    transactions: plan.transactions,
});
