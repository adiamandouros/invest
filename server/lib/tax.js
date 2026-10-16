import { dec, mul, ZERO } from './decimal.js';
import { positions } from './holdings.js';
import { inEur } from './reports.js';

// A year's figures for a Greek tax return, in EUR at the rate on each day:
// - P2P interest per platform, with tax withheld abroad and fees, and an
//   estimate of the Greek tax on it: `rate` (15% for interest) of the
//   interest, less what was withheld abroad on it, which counts up to the
//   Greek tax on the same income;
// - per ETF or share, dividends and realised gains on sales. UCITS funds
//   (European, e.g. an IE or LU ISIN) are tax-free in Greece; dividends from
//   anything else, like a US-listed ETF, are taxed at `dividendRate` (5%),
//   less the tax withheld abroad, up to that tax.
// An estimate to check, not tax advice.
//
// transactions: ledger rows; accounts, instruments: Maps by id;
// eurPer: valuation.js createRates(); rate, dividendRate: decimals, e.g. dec('0.15')

const plus = (a, b) => (a === null || b === null ? null : a + b);
const minus = (a, b) => (a === null || b === null ? null : a - b);

// Funds domiciled in the EU or the EEA are UCITS as a rule; a US ISIN never is.
// null when the ISIN doesn't tell.
const UCITS_COUNTRIES = new Set(['IE', 'LU', 'FR', 'DE', 'NL', 'AT', 'BE', 'ES', 'IT', 'FI', 'SE', 'DK', 'PT', 'GR', 'NO', 'LI']);
export function isUcits(instrument) {
    const country = instrument.isin?.slice(0, 2);
    if (!country || instrument.kind !== 'etf') return instrument.kind === 'etf' ? null : false;
    return UCITS_COUNTRIES.has(country) ? true : country === 'US' ? false : null;
}

export function taxYear({ transactions, accounts, instruments, eurPer, year, rate, dividendRate = DEFAULT_DIVIDEND_RATE }) {
    const from = `${year - 1}-12-31`;
    const to = `${year}-12-31`;
    const inYear = r => r.date > from && r.date <= to;

    // ── P2P interest per platform ──
    const p2p = [...accounts.values()].filter(a => a.kind === 'p2p').map(account => {
        const totals = { interest: ZERO, withheld: ZERO, fees: ZERO };
        for (const r of transactions) {
            if (r.accountId !== account.id || !inYear(r)) continue;
            const { amount } = inEur(r, eurPer);
            if (r.type === 'interest') totals.interest = plus(totals.interest, amount);
            else if (r.type === 'tax') totals.withheld = minus(totals.withheld, amount);
            else if (r.type === 'fee') totals.fees = minus(totals.fees, amount);
        }
        const greekTax = totals.interest === null ? null : mul(totals.interest, rate);
        // Tax withheld abroad counts against the Greek tax on the same interest, up to that tax
        const credit = greekTax === null || totals.withheld === null ? null : totals.withheld < greekTax ? totals.withheld : greekTax;
        return { account, ...totals, greekTax, credit, due: minus(greekTax, credit) };
    }).filter(p => p.interest !== ZERO || p.withheld !== ZERO || p.fees !== ZERO);
    const sum = key => p2p.reduce((total, p) => plus(total, p[key]), ZERO);

    // ── ETFs: dividends and realised gains, for the records ──
    // Rows without the broker's rate get the ECB's for their day, as on the holdings page
    const ledger = transactions.map(r => ({
        ...r, account: r.accountId, instrument: r.instrumentId,
        fxToEur: r.fxToEur !== null && r.fxToEur !== undefined ? r.fxToEur : r.currency === 'EUR' ? '1' : eurPer(r.currency, r.date),
    }));
    const before = positions(ledger.filter(r => r.date <= from));
    const after = positions(ledger.filter(r => r.date <= to));
    const etfs = [...after.values()].map(p => {
        const i = instruments.get(p.instrument);
        let dividends = ZERO;
        let withheld = ZERO;
        for (const r of transactions) {
            if (r.instrumentId !== i.id || !inYear(r)) continue;
            const { amount } = inEur(r, eurPer);
            if (r.type === 'dividend') dividends = plus(dividends, amount);
            else if (r.type === 'tax') withheld = minus(withheld, amount);
        }
        const sold = transactions.some(r => r.instrumentId === i.id && inYear(r) && (r.type === 'sell' || r.type === 'shares_out'));
        const ucits = isUcits(i);
        // Dividends outside UCITS: Greek tax, less what was withheld abroad, up to that tax
        const dividendTax = ucits === false && dividends !== null ? mul(dividends, dividendRate) : null;
        const credit = dividendTax === null || withheld === null ? null : withheld < dividendTax ? withheld : dividendTax;
        return {
            instrument: i, dividends, withheld, realised: minus(p.realisedEur, before.get(p.instrument)?.realisedEur ?? ZERO), sold,
            ucits, dividendTax, credit, due: minus(dividendTax, credit),
        };
    }).filter(e => e.sold || e.dividends !== ZERO || e.withheld !== ZERO)
        .sort((a, b) => a.instrument.symbol.localeCompare(b.instrument.symbol));
    const etfSum = key => etfs.reduce((total, e) => plus(total, e[key]), ZERO);
    const taxed = etfs.filter(e => e.dividendTax !== null && e.dividends !== ZERO);
    const taxedSum = key => taxed.reduce((total, e) => plus(total, e[key]), ZERO);

    return {
        year, from, to, rate, dividendRate,
        p2p,
        p2pTotal: { interest: sum('interest'), withheld: sum('withheld'), fees: sum('fees'), greekTax: sum('greekTax'), credit: sum('credit'), due: sum('due') },
        etfs,
        etfTotal: { dividends: etfSum('dividends'), withheld: etfSum('withheld'), realised: etfSum('realised') },
        // Dividends taxed in Greece (from outside UCITS)
        taxed,
        taxedTotal: { dividends: taxedSum('dividends'), withheld: taxedSum('withheld'), dividendTax: taxedSum('dividendTax'), credit: taxedSum('credit'), due: taxedSum('due') },
    };
}

export const DEFAULT_RATE = dec('0.15');
export const DEFAULT_DIVIDEND_RATE = dec('0.05');
