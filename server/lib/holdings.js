import { abs, dec, div, mul, ZERO } from './decimal.js';

// Holdings, cost basis and cash from an account ledger (the transactions
// table). Pure functions over rows like
//   { account, instrument, type, date, units, price, amount, currency, fee, feeCurrency, fxToEur }
// where `account` and `instrument` are any keys, and numbers are strings or
// numbers (see decimal.js).
//
// Cost basis is FIFO: a sale uses up the oldest shares first. EUR amounts use
// each row's fxToEur; when a non-EUR row has none, the EUR figures that
// depend on it are null ("unknown") rather than wrong.

const IN = new Set(['buy', 'shares_in']);
const OUT = new Set(['sell', 'shares_out']);

// EUR value of `amount` in `currency`, or null if the rate isn't known
function toEur(amount, currency, fx) {
    if (amount === ZERO || currency === 'EUR') return amount;
    return fx === null ? null : mul(amount, fx);
}

const addKnown = (a, b) => (a === null || b === null ? null : a + b);

const byDate = rows => rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (a.row.date < b.row.date ? -1 : a.row.date > b.row.date ? 1 : a.index - b.index))
    .map(({ row }) => row);

// Per instrument: { instrument, currency, units, cost (in its currency, without
// fees), costEur (with fees), realisedEur, dividends: { currency: net }, warnings }
export function positions(rows) {
    const result = new Map();
    const get = instrument => {
        if (!result.has(instrument)) {
            result.set(instrument, {
                instrument, currency: null, units: ZERO, cost: ZERO, costEur: ZERO,
                realisedEur: ZERO, dividends: {}, lots: [], warnings: [],
            });
        }
        return result.get(instrument);
    };

    for (const row of byDate(rows)) {
        if (row.instrument === null || row.instrument === undefined) continue;
        const p = get(row.instrument);
        const units = dec(row.units) ?? ZERO;
        const amount = dec(row.amount) ?? ZERO;
        const fx = dec(row.fxToEur);
        const fee = dec(row.fee) ?? ZERO;
        const feeCurrency = row.feeCurrency ?? row.currency;
        // A fee in the trade's own currency converts at the trade's rate
        const feeEur = toEur(fee, feeCurrency, feeCurrency === row.currency ? fx : null);

        if (row.type === 'dividend' || row.type === 'tax') {
            p.dividends[row.currency] = (p.dividends[row.currency] ?? ZERO) + amount;
            continue;
        }
        if (IN.has(row.type)) {
            p.currency ??= row.currency;
            // A buy's cost is the cash paid; shares received cost units × price
            const cost = row.type === 'buy' ? abs(amount) : mul(units, dec(row.price) ?? ZERO);
            const costEur = addKnown(toEur(cost, row.currency, fx), feeEur);
            p.lots.push({ units, cost, costEur });
            p.units += units;
            p.cost += cost;
            p.costEur = addKnown(p.costEur, costEur);
        } else if (OUT.has(row.type)) {
            let remaining = units;
            let usedCost = ZERO;
            let usedCostEur = ZERO;
            while (remaining > ZERO && p.lots.length) {
                const lot = p.lots[0];
                if (lot.units <= remaining) {
                    remaining -= lot.units;
                    usedCost += lot.cost;
                    usedCostEur = addKnown(usedCostEur, lot.costEur);
                    p.lots.shift();
                } else {
                    const part = div(remaining, lot.units);
                    const cost = mul(lot.cost, part);
                    const costEur = lot.costEur === null ? null : mul(lot.costEur, part);
                    lot.units -= remaining;
                    lot.cost -= cost;
                    lot.costEur = lot.costEur === null ? null : lot.costEur - costEur;
                    usedCost += cost;
                    usedCostEur = addKnown(usedCostEur, costEur);
                    remaining = ZERO;
                }
            }
            if (remaining > ZERO) p.warnings.push(`${row.date}: sold more units than were held`);
            p.units -= units;
            p.cost -= usedCost;
            p.costEur = p.costEur === null || usedCostEur === null ? null : p.costEur - usedCostEur;
            const proceedsEur = row.type === 'sell' ? toEur(amount, row.currency, fx) : ZERO;
            const realised = proceedsEur === null || feeEur === null || usedCostEur === null
                ? null : proceedsEur - feeEur - usedCostEur;
            p.realisedEur = addKnown(p.realisedEur, realised);
        }
    }
    for (const p of result.values()) delete p.lots;
    return result;
}

// Cash per account and currency: Map of "account|currency" → amount
export function cash(rows) {
    const result = new Map();
    const add = (account, currency, value) => {
        if (!currency || value === ZERO) return;
        const key = `${account}|${currency}`;
        result.set(key, (result.get(key) ?? ZERO) + value);
    };
    for (const row of rows) {
        add(row.account, row.currency, dec(row.amount) ?? ZERO);
        add(row.account, row.feeCurrency ?? row.currency, -(dec(row.fee) ?? ZERO));
    }
    return result;
}
