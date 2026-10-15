// ECB euro reference rates (official, free, one per working day at 16:00 CET):
// fetchRates(['USD', 'GBP'], from) → [{ currency, date, perEur: '1.1186' }]

const URL_BASE = 'https://data-api.ecb.europa.eu/service/data/EXR/';

export function parseCsv(text) {
    const lines = String(text).trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const header = lines[0].split(',');
    const at = name => header.indexOf(name);
    const [currency, date, value] = [at('CURRENCY'), at('TIME_PERIOD'), at('OBS_VALUE')];
    if (currency < 0 || date < 0 || value < 0) throw new Error('Unexpected answer from the ECB');
    return lines.slice(1)
        .map(line => line.split(','))
        .filter(cells => /^\d+(\.\d+)?$/.test(cells[value] ?? '') && Number(cells[value]) > 0)
        .map(cells => ({ currency: cells[currency], date: cells[date], perEur: cells[value] }));
}

export async function fetchRates(currencies, from, { fetch = globalThis.fetch } = {}) {
    const wanted = currencies.filter(c => /^[A-Z]{3}$/.test(c) && c !== 'EUR');
    if (!wanted.length) return [];
    const url = `${URL_BASE}D.${wanted.join('+')}.EUR.SP00.A?startPeriod=${from}&format=csvdata&detail=dataonly`;
    const res = await fetch(url, { headers: { Accept: 'text/csv' }, signal: AbortSignal.timeout(30_000) });
    // The ECB answers 404 when there's nothing new in the period
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`The ECB answered ${res.status}`);
    return parseCsv(await res.text());
}
