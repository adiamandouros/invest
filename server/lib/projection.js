// Where each allocation group could be in a number of years: today's value
// growing at an expected yearly return, plus a monthly amount shared between
// the groups. A lower and a higher estimate use the return minus and plus
// how much the average return over that many years may vary: the yearly
// returns' standard deviation divided by √years, as good and bad years
// partly cancel out (one standard deviation, so about two times in three
// the outcome lands between them).
// Projections are estimates, so plain floats are fine here; the page rounds
// them to euros.
//
// groups: [{ id, name, value (EUR, number), rate (a year, e.g. 0.07),
//            spread (a year, or null), weight (its share of the monthly amount) }]
// Returns one row per year from 0 (today) to `years`:
//   { year, contributed, groups: [{ id, low, mid, high }], total: { low, mid, high } }

// Standard deviation of yearly returns; null with fewer than two years
export function spreadOf(rates) {
    if (rates.length < 2) return null;
    const mean = rates.reduce((sum, r) => sum + r, 0) / rates.length;
    return Math.sqrt(rates.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (rates.length - 1));
}

const monthly = rate => (1 + Math.max(rate, -0.99)) ** (1 / 12) - 1;

// Each group's value after `months`, growing at `rates` (a year), with the monthly amount shared by weight
function grow(groups, rates, monthlyAmount, months) {
    const weights = groups.reduce((sum, g) => sum + g.weight, 0);
    const values = groups.map(g => g.value);
    const perMonth = rates.map(monthly);
    for (let m = 0; m < months; m++) {
        groups.forEach((g, i) => { values[i] = values[i] * (1 + perMonth[i]) + (weights ? monthlyAmount * (g.weight / weights) : 0); });
    }
    return values;
}

export function project({ groups, monthlyAmount = 0, years }) {
    const added = groups.some(g => g.weight > 0) ? monthlyAmount : 0;
    return Array.from({ length: years + 1 }, (_, year) => {
        const narrow = year ? Math.sqrt(year) : 1;
        const mid = grow(groups, groups.map(g => g.rate), monthlyAmount, year * 12);
        const low = grow(groups, groups.map(g => g.rate - (g.spread ?? 0) / narrow), monthlyAmount, year * 12);
        const high = grow(groups, groups.map(g => g.rate + (g.spread ?? 0) / narrow), monthlyAmount, year * 12);
        const rows = groups.map((g, i) => ({ id: g.id, low: low[i], mid: mid[i], high: high[i] }));
        const total = key => rows.reduce((sum, r) => sum + r[key], 0);
        return { year, contributed: added * 12 * year, groups: rows, total: { low: total('low'), mid: total('mid'), high: total('high') } };
    });
}
