import { dec, fixed, mul, ONE, ZERO } from './decimal.js';
import { summariseP2p } from './p2p.js';
import { xirr } from './returns.js';
import { flow, valuePortfolio } from './valuation.js';

// The total report and the yearly breakdown: what everything was worth at the
// start and end of each year, what went in, what it earned, and the same per
// holding and per allocation group. Built from snapshots: the portfolio valued
// as it stood on a day (valuation.js with only the rows up to that day).
//
// transactions: ledger rows (server/data/store.js); accounts, instruments:
// Maps by id; balances: p2p_balances rows; groups: allocation groups;
// priceOf, eurPer: valuation.js createPrices() and createRates().

const plus = (a, b) => (a === null || b === null ? null : a + b);
const minus = (a, b) => (a === null || b === null ? null : a - b);
const sumOf = list => list.reduce(plus, ZERO);
const asNumber = value => Number(fixed(value, 2));

// EUR of a row's amount and of its fee, at its own rate or the ECB's on the day
export function inEur(row, eurPer) {
    const rate = currency => (currency === 'EUR' ? ONE
        : currency === row.currency && row.fxToEur !== null && row.fxToEur !== undefined ? dec(row.fxToEur) : eurPer(currency, row.date));
    const convert = (value, currency) => {
        const v = dec(value) ?? ZERO;
        if (v === ZERO) return ZERO;
        const r = rate(currency);
        return r === null ? null : mul(v, r);
    };
    return { amount: convert(row.amount, row.currency), fee: convert(row.fee, row.feeCurrency ?? row.currency) };
}

// `inflation`: server/lib/inflation.js createInflation(), or null for no figures after it
export function createReports({ transactions, accounts, instruments, balances, groups = [], priceOf, eurPer, today, inflation = null }) {
    const rows = transactions.map(t => ({ ...t, account: t.accountId, instrument: t.instrumentId }));
    const p2pAccounts = [...accounts.values()].filter(a => a.kind === 'p2p');
    const groupIds = new Set(groups.map(g => g.id));

    // Every holding on `date`: { key, name, kind, groupId, valueEur }, and the portfolio's totals
    const cache = new Map();
    function snapshot(date) {
        if (cache.has(date)) return cache.get(date);
        const upTo = rows.filter(r => r.date <= date);
        const p2p = p2pAccounts.map(account => summariseP2p({
            account, rows: upTo.filter(r => r.accountId === account.id), balances: balances.filter(b => b.accountId === account.id), today: date,
        }));
        const v = valuePortfolio({
            transactions: upTo, priceOf, eurPer, today: date,
            accountValues: new Map(p2p.map(s => [`${s.account.id}|${s.currency}`, s.value])),
        });
        const items = new Map();
        for (const p of v.positions) {
            if (!p.open) continue;
            const i = instruments.get(p.instrument);
            items.set(`i${i.id}`, { key: `i${i.id}`, name: i.symbol, kind: 'etf', groupId: i.allocationGroupId ?? null, valueEur: p.valueEur });
        }
        for (const b of v.cash) {
            const account = accounts.get(Number(b.account));
            if (account?.kind !== 'p2p') continue;
            const key = `a${account.id}`;
            const old = items.get(key);
            items.set(key, { key, name: account.name, kind: 'p2p', groupId: account.allocationGroupId ?? null, valueEur: plus(old?.valueEur ?? ZERO, b.valueEur) });
        }
        const result = {
            date,
            valueEur: v.total.valueEur,
            investedEur: v.total.investedEur,
            realisedEur: sumOf(v.positions.map(p => p.realisedEur)),
            items,
        };
        cache.set(date, result);
        return result;
    }

    // Income and costs in EUR from the rows between two days (after `from`, up to `to`)
    function income(from, to) {
        const totals = { interest: ZERO, dividends: ZERO, tax: ZERO, fees: ZERO };
        for (const r of rows) {
            if (r.date <= from || r.date > to) continue;
            const { amount, fee } = inEur(r, eurPer);
            if (r.type === 'interest') totals.interest = plus(totals.interest, amount);
            else if (r.type === 'dividend') totals.dividends = plus(totals.dividends, amount);
            else if (r.type === 'tax') totals.tax = plus(totals.tax, amount);
            else if (r.type === 'fee') totals.fees = plus(totals.fees, amount);
            // Commissions on trades and exchanges, as negative amounts like the fee rows
            totals.fees = minus(totals.fees, fee);
        }
        return totals;
    }

    // A holding's EUR flows between two days: negative = money put into it
    function holdingFlows(key, from, to) {
        const id = Number(key.slice(1));
        let total = ZERO;
        for (const r of rows) {
            if (r.date <= from || r.date > to) continue;
            if (key[0] === 'i' && r.instrumentId === id) total = plus(total, flow(r, eurPer, true));
            if (key[0] === 'a' && r.accountId === id) total = plus(total, flow(r, eurPer, false));
        }
        return total;
    }

    // One period, from the end of `from` to the end of `to`
    function period(from, to) {
        const start = snapshot(from);
        const end = snapshot(to);
        const putIn = minus(end.investedEur, start.investedEur);
        const gain = minus(minus(end.valueEur, start.valueEur), putIn);

        // Money-weighted return over the period itself, not a yearly rate
        let periodReturn = null;
        if (end.valueEur !== null && start.valueEur !== null) {
            const flows = start.valueEur > ZERO ? [{ date: from, amount: -asNumber(start.valueEur) }] : [];
            for (const r of rows) {
                if (r.date <= from || r.date > to) continue;
                const f = flow(r, eurPer, false);
                if (f === null) { flows.length = 0; break; }
                if (f !== ZERO) flows.push({ date: r.date, amount: asNumber(f) });
            }
            const rate = flows.length ? xirr([...flows, { date: to, amount: asNumber(end.valueEur) }]) : null;
            const first = flows.length ? flows.map(f => f.date).sort()[0] : to;
            const years = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000 / 365;
            periodReturn = rate === null ? null : (1 + rate) ** years - 1;
        }

        const keys = [...new Set([...start.items.keys(), ...end.items.keys()])];
        const holdings = keys.map(key => {
            const item = end.items.get(key) ?? start.items.get(key);
            const startValue = start.items.get(key)?.valueEur ?? ZERO;
            const endValue = end.items.get(key)?.valueEur ?? ZERO;
            const flows = holdingFlows(key, from, to);
            return {
                key, name: item.name, kind: item.kind, groupId: item.groupId,
                startValue, endValue, putIn: flows === null ? null : -flows,
                gain: plus(minus(endValue, startValue), flows),
            };
        }).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'etf' ? -1 : 1));
        // Cash at brokers, currency moves and fees not in any holding: what makes the holdings add up to the total
        const rest = minus(gain, sumOf(holdings.map(h => h.gain)));

        return {
            from, to,
            startValue: start.valueEur, endValue: end.valueEur, putIn, gain, periodReturn,
            realised: minus(end.realisedEur, start.realisedEur),
            ...income(from, to),
            holdings, rest,
            groups: groupShares(end),
        };
    }

    // Each allocation group's value and share on a snapshot's day
    function groupShares(snap) {
        const values = groups.map(g => ({
            id: g.id, name: g.name, targetPct: g.targetPct,
            value: sumOf([...snap.items.values()].filter(i => i.groupId === g.id).map(i => i.valueEur)),
        }));
        const other = sumOf([...snap.items.values()].filter(i => !groupIds.has(i.groupId)).map(i => i.valueEur));
        const total = plus(sumOf(values.map(v => v.value)), other);
        const share = v => (v === null || total === null || total === ZERO ? null : Number(v) / Number(total));
        return { date: snap.date, total, other, otherShare: share(other), list: values.map(v => ({ ...v, share: share(v.value) })) };
    }

    const firstDate = rows.map(r => r.date).sort()[0] ?? null;
    const firstYear = firstDate ? Number(firstDate.slice(0, 4)) : null;
    const thisYear = Number(today.slice(0, 4));
    const yearEnd = year => (year === thisYear ? today : `${year}-12-31`);
    const monthEnd = month => {
        const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
        return end > today ? today : end;
    };
    // 'YYYY-MM' from the first row's month to today's
    function months() {
        if (!firstDate) return [];
        const list = [];
        for (let y = Number(firstDate.slice(0, 4)), m = Number(firstDate.slice(5, 7)); ; m++) {
            if (m > 12) { y++; m = 1; }
            const month = `${y}-${String(m).padStart(2, '0')}`;
            if (month > today.slice(0, 7)) break;
            list.push(month);
        }
        return list;
    }

    return {
        firstDate,
        years: firstYear === null ? [] : Array.from({ length: thisYear - firstYear + 1 }, (_, i) => thisYear - i),
        year: year => {
            const p = period(`${year - 1}-12-31`, yearEnd(year));
            // Prices' rise over the year (so far), and the year's return less it
            // Unknown (null) for a year with no published month yet
            const prices = inflation && p.from.slice(0, 7) < inflation.lastMonth ? inflation.between(p.from, p.to) : null;
            return { year, ...p, inflation: prices, realReturn: prices === null ? null : inflation.real(p.periodReturn, prices) };
        },
        // The value and the money put in at the end of each month (the last one ends today)
        series: () => months().map(month => {
            const s = snapshot(monthEnd(month));
            return { month, date: s.date, valueEur: s.valueEur, investedEur: s.investedEur };
        }),
        // P2P interest, dividends and tax withheld per month, in EUR
        income: () => months().map(month => {
            const { interest, dividends, tax } = income(`${month}-00`, monthEnd(month));
            return { month, interest, dividends, tax };
        }),
        // Everything from before the first row to today, with the yearly rate (XIRR)
        // Each allocation group's past, with holdings in today's groups: its value
        // now, its return a year since it started (XIRR), and its return in each
        // whole year it was held from the start (the first, partial year left out).
        // Holdings in no group are one more, with id null ("Everything" when
        // there are no groups).
        groupHistory() {
            const now = snapshot(today);
            const keyOf = r => (r.instrumentId ? `i${r.instrumentId}` : accounts.get(r.accountId)?.kind === 'p2p' ? `a${r.accountId}` : null);
            const groupOf = key => {
                const id = Number(key.slice(1));
                const groupId = (key[0] === 'i' ? instruments.get(id) : accounts.get(id))?.allocationGroupId ?? null;
                return groupIds.has(groupId) ? groupId : null;
            };
            const list = [...groups.map(g => ({ id: g.id, name: g.name, targetPct: g.targetPct })),
                { id: null, name: groups.length ? 'Not in a group' : 'Everything', targetPct: null }];
            return list.map(g => {
                const valueAt = snap => sumOf([...snap.items.values()].filter(i => groupOf(i.key) === g.id).map(i => i.valueEur));
                // The group's dated EUR flows after `from`, up to `to` (null if a rate is missing)
                const flowsBetween = (from, to) => {
                    const list = [];
                    for (const r of rows) {
                        if (r.date <= from || r.date > to) continue;
                        const key = keyOf(r);
                        if (!key || groupOf(key) !== g.id) continue;
                        const f = flow(r, eurPer, key[0] === 'i');
                        if (f === null) return null;
                        if (f !== ZERO) list.push({ date: r.date, amount: asNumber(f) });
                    }
                    return list;
                };
                const value = valueAt(now);
                const all = flowsBetween('0000-00-00', today);
                const years = [];
                for (let y = firstYear ?? thisYear; y < thisYear; y++) {
                    const from = `${y - 1}-12-31`;
                    const to = `${y}-12-31`;
                    const start = valueAt(snapshot(from));
                    const end = valueAt(snapshot(to));
                    const flows = flowsBetween(from, to);
                    if (start === null || end === null || flows === null || start <= ZERO) continue;
                    const rate = xirr([{ date: from, amount: -asNumber(start) }, ...flows, { date: to, amount: asNumber(end) }]);
                    if (rate !== null) years.push({ year: y, rate });
                }
                return {
                    ...g, value, years,
                    xirr: value === null || all === null || !all.length ? null : xirr([...all, { date: today, amount: asNumber(value) }]),
                };
            }).filter(g => g.id !== null || (g.value !== null && g.value > ZERO));
        },
        total() {
            const all = period(firstDate ? `${Number(firstDate.slice(0, 4)) - 1}-12-31` : today, today);
            const flows = [];
            for (const r of rows) {
                const f = flow(r, eurPer, false);
                if (f === null) return { ...all, xirr: null };
                if (f !== ZERO) flows.push({ date: r.date, amount: asNumber(f) });
            }
            const end = all.endValue === null ? null : { date: today, amount: asNumber(all.endValue) };
            // After inflation: every flow in today's euros
            const real = inflation && all.endValue !== null
                ? xirr([...flows.map(f => ({ ...f, amount: f.amount * inflation.factor(f.date, today) })), end]) : null;
            return {
                ...all, xirr: all.endValue === null ? null : xirr([...flows, end]), realXirr: real,
                inflation: inflation && firstDate ? inflation.between(firstDate, today) : null, inflationUntil: inflation?.lastMonth ?? null,
            };
        },
    };
}
