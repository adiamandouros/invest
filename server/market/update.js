import { positions } from '../lib/holdings.js';
import { fetchPriceIndex, fetchRates } from './ecb.js';
import { fetchHistory, suggestSymbol } from './yahoo.js';

// Brings prices and exchange rates up to date: for each instrument still
// held, the closes since the last stored one (or since its first
// transaction); for one sold since, its history once, so past years can be
// valued; for the benchmark (server/lib/benchmark.js), from the first
// ledger row; ECB rates for every currency the ledger uses; and Greece's
// monthly consumer price index, for figures after inflation. One request
// per instrument and one for all rates. `data` is server/data/store.js.

const DAY_MS = 86_400_000;
const STALE_MS = 6 * 3_600_000; // prices older than this are refreshed when a page needs them
const RETRY_MS = 10 * 60_000;   // and not tried again sooner than this after a failure
const weekBefore = date => new Date(Date.parse(`${date}T00:00:00Z`) - 7 * DAY_MS).toISOString().slice(0, 10);
// Greece's consumer prices (HICP) for figures after inflation (server/lib/inflation.js)
export const INFLATION_AREA = 'GR';
const nextMonth = month => {
    const [y, m] = month.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const nextDay = date => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

export async function updateMarketData(data, { fetch = globalThis.fetch, now = Date.now, log = console.log } = {}) {
    const today = new Date(now()).toISOString().slice(0, 10);
    const [instruments, transactions, lastPrices, lastFx, settings] = await Promise.all([
        data.listInstruments(), data.listTransactions(), data.lastPriceDates(), data.lastFxDates(), data.settings(),
    ]);
    const benchmarkId = Number(settings.benchmark_instrument) || null;
    if (!transactions.length) return { prices: 0, rates: 0, problems: [] };

    const held = positions(transactions.map(t => ({ ...t, account: t.accountId, instrument: t.instrumentId })));
    const firstDate = new Map();
    for (const t of transactions) if (t.instrumentId && !firstDate.has(t.instrumentId)) firstDate.set(t.instrumentId, t.date);

    // ── Prices ──
    const problems = [];
    const currencies = new Set(transactions.flatMap(t => [t.currency, t.feeCurrency]).filter(Boolean));
    let prices = 0;
    for (const i of instruments) {
        const benchmark = i.id === benchmarkId;
        const sold = !held.get(i.id)?.units && !benchmark;
        if ((!firstDate.has(i.id) && !benchmark) || i.priceSource === 'none' || (sold && lastPrices[i.id])) continue;
        let symbol = i.priceSymbol;
        if (!symbol) {
            symbol = suggestSymbol(i);
            await data.setPriceSymbol(i.id, symbol, 'yahoo');
        }
        // The benchmark from a week before the first row, so money put in on a weekend has a price
        const from = lastPrices[i.id] ? nextDay(lastPrices[i.id]) : firstDate.get(i.id) ?? weekBefore(transactions[0].date);
        if (!from || from > today) continue;
        try {
            const list = await fetchHistory(symbol, from, { fetch, now });
            await data.savePrices(list.map(p => ({ instrumentId: i.id, date: p.date, close: p.close, currency: p.currency, source: 'yahoo' })));
            for (const p of list) currencies.add(p.currency);
            prices += list.length;
        } catch (err) {
            problems.push(`${i.symbol} (${symbol} on Yahoo Finance): ${err.message}`);
        }
    }
    await data.setMarketStatus('prices', problems.length === 0, problems.join('; ') || `${prices} new prices`);

    // ── Exchange rates: one request per start date ──
    const earliest = transactions[0].date;
    const byStart = new Map();
    for (const c of currencies) {
        if (c === 'EUR') continue;
        const from = lastFx[c] ? nextDay(lastFx[c]) : earliest;
        if (from > today) continue;
        if (!byStart.has(from)) byStart.set(from, []);
        byStart.get(from).push(c);
    }
    let rates = 0;
    const fxProblems = [];
    for (const [from, list] of byStart) {
        try {
            const found = await fetchRates(list, from, { fetch });
            await data.saveFxRates(found);
            rates += found.length;
        } catch (err) {
            fxProblems.push(`${list.join(', ')}: ${err.message}`);
        }
    }
    await data.setMarketStatus('fx', fxProblems.length === 0, fxProblems.join('; ') || `${rates} new rates`);
    problems.push(...fxProblems);

    // ── Consumer prices: the months after the last one stored ──
    let months = 0;
    try {
        const known = await data.listPriceIndex(INFLATION_AREA);
        const from = known.length ? nextMonth(known.at(-1).month) : `${Number(earliest.slice(0, 4)) - 1}-12`;
        const found = await fetchPriceIndex(INFLATION_AREA, from, { fetch });
        await data.savePriceIndex(found);
        months = found.length;
        await data.setMarketStatus('inflation', true, `${months} new months`);
    } catch (err) {
        await data.setMarketStatus('inflation', false, `Consumer prices: ${err.message}`);
        problems.push(`Consumer prices: ${err.message}`);
    }

    log(`[market] ${prices} prices, ${rates} rates, ${months} months of consumer prices${problems.length ? `; problems: ${problems.join('; ')}` : ''}`);
    return { prices, rates, problems };
}

// Runs updates one at a time, and in the background when the data is stale
export function createMarketUpdater(data, options = {}) {
    const now = options.now ?? Date.now;
    let running = null;
    let lastStart = 0;
    const run = () => {
        lastStart = now();
        running ??= updateMarketData(data, options).finally(() => { running = null; });
        return running;
    };
    return {
        run,
        get running() { return Boolean(running); },
        // True if an update was started
        async refreshIfStale() {
            if (running) return false;
            const status = await data.marketStatus();
            const checked = status.prices?.checkedAt ? Date.parse(`${status.prices.checkedAt.replace(' ', 'T')}Z`) : 0;
            if (now() - checked < STALE_MS || now() - lastStart < RETRY_MS) return false;
            run().catch(err => console.error(`[market] ${err.message}`));
            return true;
        },
    };
}
