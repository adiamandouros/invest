import { dec, fixed, ZERO } from './decimal.js';
import { xirr } from './returns.js';

// A P2P account from its ledger rows and balances (the p2p_balances table).
// The ledger's sum is the account's value (cash plus loans at nominal value,
// see server/import/mintos.js). A balance with a value, entered from the
// platform, replaces the ledger's figure from its day on, so losses and
// write-offs the statements don't list still count:
//   value today = latest such value + the ledger rows after its day.
// Everything is in the account's currency; rows in other currencies are left
// out and reported.

const INCOME = { interest: 'interest', tax: 'tax', fee: 'fees' };
const IN = new Set(['deposit', 'transfer_in']);
const OUT = new Set(['withdrawal', 'transfer_out']);

const net = row => (dec(row.amount) ?? ZERO) - (dec(row.fee) ?? ZERO);

// `rows`: the account's transactions; `balances`: its p2p_balances rows
export function summariseP2p({ account, rows, balances = [], today }) {
    const currency = account.baseCurrency;
    const own = rows.filter(r => r.currency === currency && r.date <= today);
    const others = rows.filter(r => r.currency !== currency);
    const totals = { deposited: ZERO, withdrawn: ZERO, interest: ZERO, tax: ZERO, fees: ZERO };
    const months = new Map();
    const flows = [];
    let ledger = ZERO;

    for (const r of own) {
        const amount = net(r);
        ledger += amount;
        if (IN.has(r.type)) {
            totals.deposited += amount;
            flows.push({ date: r.date, amount: -Number(fixed(amount)) });
        } else if (OUT.has(r.type)) {
            totals.withdrawn -= amount;
            flows.push({ date: r.date, amount: -Number(fixed(amount)) });
        } else if (INCOME[r.type]) {
            totals[INCOME[r.type]] += amount;
            const month = r.date.slice(0, 7);
            const m = months.get(month) ?? { month, interest: ZERO, tax: ZERO, fees: ZERO, cash: null };
            m[INCOME[r.type]] += amount;
            months.set(month, m);
        }
    }

    const dated = balances.filter(b => b.date <= today).sort((a, b) => (a.date < b.date ? -1 : 1));
    const valued = dated.filter(b => b.value !== null && b.value !== undefined).at(-1) ?? null;
    const value = valued
        ? dec(valued.value) + own.filter(r => r.date > valued.date).reduce((sum, r) => sum + net(r), ZERO)
        : ledger;
    const cashRow = dated.filter(b => b.cash !== null && b.cash !== undefined).at(-1) ?? null;
    for (const b of dated) {
        if (b.cash === null || b.cash === undefined) continue;
        const m = months.get(b.date.slice(0, 7));
        if (m) m.cash = dec(b.cash);
    }

    const contributed = totals.deposited - totals.withdrawn;
    const income = totals.interest + totals.tax + totals.fees;
    const years = new Map();
    for (const m of months.values()) {
        const year = m.month.slice(0, 4);
        const y = years.get(year) ?? { year, interest: ZERO, tax: ZERO, fees: ZERO };
        y.interest += m.interest;
        y.tax += m.tax;
        y.fees += m.fees;
        years.set(year, y);
    }
    const withNet = x => ({ ...x, net: x.interest + x.tax + x.fees });
    const newestFirst = (a, b) => (a < b ? 1 : -1);

    return {
        account,
        currency,
        value,
        // The balance the value starts from, or null when it's the ledger alone
        valuedOn: valued?.date ?? null,
        // What the entered value differs from the ledger by on its day (losses, mostly)
        adjustment: valued ? dec(valued.value) - own.filter(r => r.date <= valued.date).reduce((sum, r) => sum + net(r), ZERO) : ZERO,
        cash: cashRow ? { date: cashRow.date, amount: dec(cashRow.cash) } : null,
        ...totals,
        contributed,
        income,
        gain: value - contributed,
        xirr: own.length ? xirr([...flows, { date: today, amount: Number(fixed(value)) }]) : null,
        years: [...years.values()].map(withNet).sort((a, b) => newestFirst(a.year, b.year)),
        months: [...months.values()].map(withNet).sort((a, b) => newestFirst(a.month, b.month)),
        otherCurrencies: [...new Set(others.map(r => r.currency))],
    };
}
