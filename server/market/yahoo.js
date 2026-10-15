// Daily closing prices from Yahoo Finance's chart endpoint. It's unofficial,
// so it sits behind this one function: fetchHistory(symbol, from) →
// [{ date: 'YYYY-MM-DD', close: '149.5', currency: 'USD' }], oldest first.

const URL_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const DAY = 86_400;

// Prices in pence (GBp) or cents (ZAc, ILA) are turned into the main unit
const MINOR_UNITS = { GBp: ['GBP', 100], GBX: ['GBP', 100], ZAc: ['ZAR', 100], ILA: ['ILS', 100] };

// A timestamp's date where the exchange is
function localDate(seconds, timeZone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(seconds * 1000));
}

export function parseChart(json) {
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(json?.chart?.error?.description ?? 'No data in the answer');
    const { currency: quoted, exchangeTimezoneName } = result.meta ?? {};
    const [currency, divisor] = MINOR_UNITS[quoted] ?? [quoted, 1];
    if (!/^[A-Z]{3}$/.test(currency ?? '')) throw new Error(`Unknown currency "${quoted}"`);
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const byDate = new Map();
    (result.timestamp ?? []).forEach((t, i) => {
        const close = closes[i];
        if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) return;
        // Rounded to 6 decimals: Yahoo sends floats like 149.49999237060547
        byDate.set(localDate(t, exchangeTimezoneName), (close / divisor).toFixed(6).replace(/\.?0+$/, ''));
    });
    return [...byDate].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, close]) => ({ date, close, currency }));
}

export async function fetchHistory(symbol, from, { fetch = globalThis.fetch, now = Date.now } = {}) {
    const period1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
    const period2 = Math.floor(now() / 1000) + DAY;
    const url = `${URL_BASE}${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Invest/1.0)', Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok && !json?.chart) throw new Error(`Yahoo Finance answered ${res.status} for ${symbol}`);
    return parseChart(json);
}

// A first guess at Yahoo's symbol from the broker's ticker: Freedom24 writes
// US listings as VTI.US and European ones as VUAA.EU (a USD line, on London).
export function suggestSymbol({ symbol, currency }) {
    const [base, market] = String(symbol).split('.');
    if (!market) return symbol;
    if (market === 'US') return base;
    if (market === 'EU') return currency === 'USD' || currency === 'GBP' ? `${base}.L` : `${base}.DE`;
    return symbol;
}
