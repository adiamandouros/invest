import { dec, div, fixed, mul, ONE, ZERO } from './decimal.js';
import { cash, positions } from './holdings.js';
import { xirr } from './returns.js';

// Market value and returns: the ledger (holdings.js) plus daily prices and
// ECB exchange rates.

// rates: [{ currency, date, perEur }] (ECB: units of currency for 1 EUR).
// Returns eurPer(currency, date): EUR for 1 unit on that date, or on the last
// working day before it (weekends, holidays); null if there's no rate yet.
export function createRates(rows) {
    const byCurrency = new Map();
    for (const r of rows) {
        if (!byCurrency.has(r.currency)) byCurrency.set(r.currency, []);
        byCurrency.get(r.currency).push({ date: r.date, eur: div(ONE, dec(r.perEur)) });
    }
    for (const list of byCurrency.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));
    return (currency, date) => {
        if (currency === 'EUR') return ONE;
        return lastOnOrBefore(byCurrency.get(currency), date)?.eur ?? null;
    };
}

// prices: [{ instrumentId, date, close, currency }]. Returns priceOf(instrumentId, date):
// the last close on or before the date, as { date, close, currency }, or null.
export function createPrices(rows) {
    const byInstrument = new Map();
    for (const r of rows) {
        if (!byInstrument.has(r.instrumentId)) byInstrument.set(r.instrumentId, []);
        byInstrument.get(r.instrumentId).push({ date: r.date, close: dec(r.close), currency: r.currency });
    }
    for (const list of byInstrument.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));
    return (instrumentId, date = '9999-12-31') => lastOnOrBefore(byInstrument.get(instrumentId), date);
}

function lastOnOrBefore(list, date) {
    if (!list?.length || list[0].date > date) return null;
    let low = 0;
    let high = list.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (list[mid].date <= date) low = mid; else high = mid - 1;
    }
    return list[low];
}

const toEur = (amount, currency, date, rowFx, eurPer) => {
    if (amount === ZERO) return ZERO;
    const fx = currency === 'EUR' ? ONE : rowFx ?? eurPer(currency, date);
    return fx === null ? null : mul(amount, fx);
};
const plus = (a, b) => (a === null || b === null ? null : a + b);
const asNumber = value => (value === null ? null : Number(fixed(value, 2)));

// The EUR cash flow of one ledger row, seen from the instrument (holding = true)
// or from the whole portfolio, as money put in (negative) or taken out (positive)
function flow(row, eurPer, holding) {
    const fx = row.fxToEur === null || row.fxToEur === undefined ? null : dec(row.fxToEur);
    const amount = toEur(dec(row.amount) ?? ZERO, row.currency, row.date, fx, eurPer);
    const feeCurrency = row.feeCurrency ?? row.currency;
    const fee = toEur(dec(row.fee) ?? ZERO, feeCurrency, row.date, feeCurrency === row.currency ? fx : null, eurPer);
    const sharesValue = () => toEur(mul(dec(row.units) ?? ZERO, dec(row.price) ?? ZERO), row.currency, row.date, fx, eurPer);
    if (holding) {
        if (['buy', 'sell', 'dividend', 'tax'].includes(row.type)) return amount === null || fee === null ? null : amount - fee;
        if (row.type === 'shares_in') { const v = sharesValue(); return v === null ? null : -v; }
        if (row.type === 'shares_out') return sharesValue();
        return ZERO;
    }
    if (['deposit', 'withdrawal', 'transfer_in', 'transfer_out'].includes(row.type)) return amount === null ? null : -amount;
    if (row.type === 'shares_in') { const v = sharesValue(); return v === null ? null : -v; }
    if (row.type === 'shares_out') return sharesValue();
    return ZERO;
}

// Everything the holdings page shows. `transactions` are ledger rows with
// `account` and `instrument` keys; `priceOf`, `eurPer` from the functions above.
export function valuePortfolio({ transactions, priceOf, eurPer, today }) {
    // Rows without the broker's rate get the ECB's for their day
    const rows = transactions.map(r => (r.fxToEur !== null && r.fxToEur !== undefined) || r.currency === 'EUR'
        ? r : { ...r, fxToEur: eurPer(r.currency, r.date) });
    const held = positions(rows);

    const list = [...held.values()].map(p => {
        const open = p.units !== ZERO;
        const price = open ? priceOf(p.instrument, today) : null;
        const rate = price ? eurPer(price.currency, today) : null;
        const valueEur = !open ? ZERO : price && rate !== null ? mul(mul(p.units, price.close), rate) : null;
        const unrealisedEur = open && valueEur !== null && p.costEur !== null ? valueEur - p.costEur : null;
        let dividendsEur = ZERO;
        const flows = [];
        for (const r of rows.filter(r => r.instrument === p.instrument)) {
            const f = flow(r, eurPer, true);
            if (r.type === 'dividend' || r.type === 'tax') dividendsEur = plus(dividendsEur, f);
            if (f === null) { flows.length = 0; flows.push(null); break; }
            if (f !== ZERO) flows.push({ date: r.date, amount: asNumber(f) });
        }
        const known = !flows.includes(null) && valueEur !== null;
        if (known && open) flows.push({ date: today, amount: asNumber(valueEur) });
        return { ...p, open, price, valueEur, unrealisedEur, dividendsEur, xirr: known ? xirr(flows) : null };
    });

    const balances = [...cash(rows)].filter(([, amount]) => amount !== ZERO).map(([key, amount]) => {
        const [account, currency] = key.split('|');
        const rate = eurPer(currency, today);
        return { account, currency, amount, valueEur: rate === null ? null : mul(amount, rate) };
    });

    // The whole portfolio: what went in and out of the accounts, and what's there now
    const openValues = list.filter(p => p.open).map(p => p.valueEur);
    const valueEur = [...openValues, ...balances.map(b => b.valueEur)].reduce(plus, ZERO);
    let contributed = ZERO;
    const flows = [];
    for (const r of rows) {
        const f = flow(r, eurPer, false);
        contributed = plus(contributed, f === null ? null : -f);
        if (f !== null && f !== ZERO) flows.push({ date: r.date, amount: asNumber(f) });
    }
    const complete = valueEur !== null && contributed !== null;
    const costEur = list.filter(p => p.open).map(p => p.costEur).reduce(plus, ZERO);
    const pricedDates = list.filter(p => p.open && p.price).map(p => p.price.date).sort();

    return {
        positions: list,
        cash: balances,
        total: {
            valueEur,
            costEur,
            unrealisedEur: valueEur === null || costEur === null ? null
                : list.filter(p => p.open).map(p => p.unrealisedEur).reduce(plus, ZERO),
            investedEur: contributed,
            gainEur: complete ? valueEur - contributed : null,
            xirr: complete ? xirr([...flows, { date: today, amount: asNumber(valueEur) }]) : null,
        },
        // The oldest of the latest prices, so "prices as of" is true for all of them
        pricesAsOf: pricedDates[0] ?? null,
        missingPrices: list.filter(p => p.open && !p.price).map(p => p.instrument),
    };
}

