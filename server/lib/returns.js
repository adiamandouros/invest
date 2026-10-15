// Money-weighted return (XIRR): the yearly rate at which all cash flows,
// discounted to the first date, add up to zero. Flows are { date, amount }
// with money put in negative and money got back (including what the holding
// is worth today) positive, like Excel's XIRR with a 365-day year. Rates are
// the one place floats are fine: they're shown rounded to a tenth of a percent.

const DAY_MS = 86_400_000;

export function xirr(flows) {
    const points = flows
        .map(f => ({ t: Date.parse(`${f.date}T00:00:00Z`), amount: Number(f.amount) }))
        .filter(p => Number.isFinite(p.t) && Number.isFinite(p.amount) && p.amount !== 0);
    if (!points.some(p => p.amount < 0) || !points.some(p => p.amount > 0)) return null;
    const start = Math.min(...points.map(p => p.t));
    const years = points.map(p => ({ y: (p.t - start) / DAY_MS / 365, amount: p.amount }));
    // Too short to annualise meaningfully
    if (Math.max(...years.map(p => p.y)) < 1 / 365) return null;

    const npv = rate => years.reduce((sum, p) => sum + p.amount / (1 + rate) ** p.y, 0);
    const slope = rate => years.reduce((sum, p) => sum - (p.y * p.amount) / (1 + rate) ** (p.y + 1), 0);

    // Newton's method from 10%, which converges in a few steps for ordinary investments
    let rate = 0.1;
    for (let i = 0; i < 50; i++) {
        const value = npv(rate);
        const d = slope(rate);
        if (!Number.isFinite(value) || !d) break;
        const next = rate - value / d;
        if (!Number.isFinite(next) || next <= -1) break;
        if (Math.abs(next - rate) < 1e-10) return next;
        rate = next;
    }

    // Otherwise bisection, between -99.99% and +1,000,000% a year
    let low = -0.9999;
    let high = 10_000;
    let lowValue = npv(low);
    if (Math.sign(lowValue) === Math.sign(npv(high))) return null;
    for (let i = 0; i < 300; i++) {
        const mid = (low + high) / 2;
        const value = npv(mid);
        if (Math.abs(value) < 1e-9 || high - low < 1e-12) return mid;
        if (Math.sign(value) === Math.sign(lowValue)) { low = mid; lowValue = value; } else high = mid;
    }
    return (low + high) / 2;
}
