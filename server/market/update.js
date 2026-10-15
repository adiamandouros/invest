import { positions } from '../lib/holdings.js';
import { fetchRates } from './ecb.js';
import { fetchHistory, suggestSymbol } from './yahoo.js';

// Brings prices and exchange rates up to date: for each instrument still
// held, the closes since the last stored one (or since its first
// transaction); for one sold since, its history once, so past years can be
// valued; and ECB rates for every currency the ledger uses. One request
// per instrument and one for all rates. `data` is server/data/store.js.

const DAY_MS = 86_400_000;
const STALE_MS = 6 * 3_600_000; // prices older than this are refreshed when a page needs them
const RETRY_MS = 10 * 60_000;   // and not tried again sooner than this after a failure
const nextDay = date => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

export async function updateMarketData(data, { fetch = globalThis.fetch, now = Date.now, log = console.log } = {}) {
    const today = new Date(now()).toISOString().slice(0, 10);
    const [instruments, transactions, lastPrices, lastFx] = await Promise.all([
        data.listInstruments(), data.listTransactions(), data.lastPriceDates(), data.lastFxDates(),
    ]);
    if (!transactions.length) return { prices: 0, rates: 0, problems: [] };

    const held = positions(transactions.map(t => ({ ...t, account: t.accountId, instrument: t.instrumentId })));
    const firstDate = new Map();
    for (const t of transactions) if (t.instrumentId && !firstDate.has(t.instrumentId)) firstDate.set(t.instrumentId, t.date);

    // ── Prices ──
    const problems = [];
    const currencies = new Set(transactions.flatMap(t => [t.currency, t.feeCurrency]).filter(Boolean));
    let prices = 0;
    for (const i of instruments) {
        const sold = !held.get(i.id)?.units;
        if (!firstDate.has(i.id) || i.priceSource === 'none' || (sold && lastPrices[i.id])) continue;
        let symbol = i.priceSymbol;
        if (!symbol) {
            symbol = suggestSymbol(i);
            await data.setPriceSymbol(i.id, symbol, 'yahoo');
        }
        const from = lastPrices[i.id] ? nextDay(lastPrices[i.id]) : firstDate.get(i.id);
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

    log(`[market] ${prices} prices, ${rates} rates${problems.length ? `; problems: ${problems.join('; ')}` : ''}`);
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
