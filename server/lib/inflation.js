// Figures after inflation, from a monthly consumer price index
// ([{ month: 'YYYY-MM', index }], e.g. Greece's HICP from the ECB). A day uses
// its month's index; months before the first or after the last known one use
// those, so the newest months count as no inflation until the ECB publishes them.

export function createInflation(rows) {
    const list = rows.map(r => ({ month: r.month, index: Number(r.index) })).filter(r => r.index > 0)
        .sort((a, b) => (a.month < b.month ? -1 : 1));
    if (!list.length) return null;
    const indexAt = date => {
        const month = date.slice(0, 7);
        let found = list[0];
        for (const r of list) { if (r.month > month) break; found = r; }
        return found.index;
    };
    return {
        lastMonth: list.at(-1).month,
        // Prices rose by this much from one day to another, e.g. 0.031 for 3.1%
        between: (from, to) => indexAt(to) / indexAt(from) - 1,
        // A euro on `date` is worth this many euros of `today`
        factor: (date, today) => indexAt(today) / indexAt(date),
        // A return over a period, less the inflation over it
        real: (rate, inflation) => (rate === null || rate === undefined ? null : (1 + rate) / (1 + inflation) - 1),
    };
}
