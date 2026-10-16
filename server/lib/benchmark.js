import { dec, div, fixed, mul, ZERO } from './decimal.js';
import { xirr } from './returns.js';
import { flow } from './valuation.js';

// What the portfolio would be worth if every euro put in had bought one
// benchmark instead (like an all-world ETF), on the same day, and every
// withdrawal had sold it: the same money in and out at the same times, so
// the difference is down to what was chosen.
//
// transactions: ledger rows; prices: the benchmark's [{ date, close, currency }];
// eurPer: valuation.js createRates(); dates: days to value it on (e.g. month ends).
// Money put in before the benchmark's first price buys at that first price.

export function benchmark({ transactions, prices, eurPer, today, dates = [] }) {
    const list = [...prices].map(p => ({ date: p.date, close: dec(p.close), currency: p.currency }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!list.length) return null;
    // The close on or before the day in EUR, or the first one for days before it
    const priceEur = date => {
        let p = list[0];
        for (const q of list) { if (q.date > date) break; p = q; }
        const rate = eurPer(p.currency, date) ?? eurPer(p.currency, p.date);
        return rate === null ? null : mul(p.close, rate);
    };

    const rows = transactions.map(t => ({ ...t, account: t.accountId, instrument: t.instrumentId }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const steps = [];
    const flows = [];
    let units = ZERO;
    for (const r of rows) {
        if (r.date > today) break;
        // Money put in is negative, money taken out positive
        const f = flow(r, eurPer, false);
        if (f === null) return null;
        if (f === ZERO) continue;
        const price = priceEur(r.date);
        if (price === null || price === ZERO) return null;
        units -= div(f, price);
        steps.push({ date: r.date, units });
        flows.push({ date: r.date, amount: Number(fixed(f, 2)) });
    }
    const unitsOn = date => steps.filter(s => s.date <= date).at(-1)?.units ?? ZERO;
    const valueOn = date => {
        const price = priceEur(date);
        return price === null ? null : mul(unitsOn(date), price);
    };
    const value = valueOn(today);
    return {
        value,
        xirr: value === null || !flows.length ? null : xirr([...flows, { date: today, amount: Number(fixed(value, 2)) }]),
        series: dates.map(date => ({ date, value: valueOn(date) })),
        firstPrice: list[0].date,
        lastPrice: list.at(-1).date,
    };
}
