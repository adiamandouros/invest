import { dec, div, fixed, mul, ZERO } from './decimal.js';

// How the portfolio is split between allocation groups, against their
// targets, and how to split new money to get back towards them.
//
// groups: [{ id, name, targetPct }] (percent strings, adding up to 100)
// items: [{ key, name, groupId, valueEur }] (decimals; valueEur null = unknown)
// amount: money to invest (decimal), or null
//
// New money is only ever added, never moved: a group above its target gets
// nothing, and the rest is shared so the others reach their targets
// together. When the amount is too small for that, the groups furthest
// below target get it first; `exactAmount` is what it would take to land on
// every target exactly.

const HUNDRED = dec('100');
const share = (part, whole) => (whole > ZERO ? Number(fixed(div(part, whole), 8)) : null);

export function allocation({ groups, items, amount = null }) {
    const assigned = items.filter(i => groups.some(g => g.id === i.groupId));
    const unassigned = items.filter(i => !groups.some(g => g.id === i.groupId));
    const missing = assigned.filter(i => i.valueEur === null);
    const targetSum = groups.reduce((sum, g) => sum + dec(g.targetPct), ZERO);

    const rows = groups.map(g => {
        const members = assigned.filter(i => i.groupId === g.id);
        const value = members.reduce((sum, i) => sum + (i.valueEur ?? ZERO), ZERO);
        return { id: g.id, name: g.name, target: div(dec(g.targetPct), HUNDRED), targetPct: dec(g.targetPct), items: members, value };
    });
    const total = rows.reduce((sum, r) => sum + r.value, ZERO);
    for (const r of rows) {
        r.share = share(r.value, total);
        // Above (positive) or below its target, in EUR
        r.off = r.value - mul(r.target, total);
    }

    const ready = groups.length > 0 && targetSum === HUNDRED && !missing.length;
    const result = { groups: rows, total, unassigned, missing, targetSum, ready, plan: null };
    if (!ready || amount === null || amount <= ZERO) return result;

    // Groups that get money: start with all that have a target, drop any that
    // would need selling, and share again among the rest
    let active = rows.filter(r => r.target > ZERO);
    let buys = new Map();
    for (;;) {
        const targets = active.reduce((sum, r) => sum + r.target, ZERO);
        const pool = amount + active.reduce((sum, r) => sum + r.value, ZERO);
        buys = new Map(active.map(r => [r.id, mul(pool, div(r.target, targets)) - r.value]));
        const over = active.filter(r => buys.get(r.id) < ZERO);
        if (!over.length) break;
        active = active.filter(r => !over.includes(r));
    }

    // In whole cents, adding up to the amount exactly
    const cents = v => BigInt(fixed(v, 2).replace('.', ''));
    const centBuys = new Map(rows.map(r => [r.id, buys.has(r.id) ? cents(buys.get(r.id)) : 0n]));
    const drift = cents(amount) - [...centBuys.values()].reduce((sum, c) => sum + c, 0n);
    if (drift !== 0n) {
        const biggest = [...centBuys].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))[0][0];
        centBuys.set(biggest, centBuys.get(biggest) + drift);
    }
    const after = total + amount;
    const exactAmount = rows.filter(r => r.target > ZERO)
        .reduce((most, r) => { const needed = div(r.value, r.target); return needed > most ? needed : most; }, ZERO) - total;

    result.plan = {
        amount,
        after,
        exactAmount: exactAmount > ZERO ? exactAmount : ZERO,
        exact: amount >= exactAmount,
        groups: rows.map(r => {
            const buy = div(dec(String(centBuys.get(r.id))), HUNDRED);
            return { id: r.id, name: r.name, buy, value: r.value + buy, share: share(r.value + buy, after), targetPct: r.targetPct };
        }),
    };
    return result;
}
