import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { applyImport, parseStatement, planImport } from '../server/import/index.js';
import { fixed } from '../server/lib/decimal.js';
import { xirr } from '../server/lib/returns.js';
import { createPrices, createRates, valuePortfolio } from '../server/lib/valuation.js';
import { parseCsv } from '../server/market/ecb.js';
import { createMarketUpdater, updateMarketData } from '../server/market/update.js';
import { parseChart, suggestSymbol } from '../server/market/yahoo.js';
import { createMemoryData } from './helpers/memory-data.js';

const REPORT = readFileSync(new URL('./fixtures/freedom24-report.json', import.meta.url), 'utf8');

test('XIRR matches Excel\'s documented example, and needs money both ways', () => {
    const rate = xirr([
        { date: '2008-01-01', amount: -10000 }, { date: '2008-03-01', amount: 2750 }, { date: '2008-10-30', amount: 4250 },
        { date: '2009-02-15', amount: 3250 }, { date: '2009-04-01', amount: 2750 },
    ]);
    assert.ok(Math.abs(rate - 0.373362535) < 1e-6, String(rate));
    assert.ok(Math.abs(xirr([{ date: '2021-01-01', amount: -100 }, { date: '2022-01-01', amount: 90 }]) + 0.1) < 1e-9);
    assert.equal(xirr([{ date: '2021-01-01', amount: -100 }]), null);
    assert.equal(xirr([{ date: '2021-01-01', amount: -100 }, { date: '2021-01-01', amount: 100 }]), null, 'no time passed');
});

test('Yahoo closes are dated where the exchange is, in the main currency unit', () => {
    const chart = currency => ({ chart: { result: [{
        meta: { currency, exchangeTimezoneName: 'Europe/London' },
        timestamp: [1792000000, 1792087564, 1792087600],
        indicators: { quote: [{ close: [149.49999237060547, null, 150] }] },
    }] } });
    assert.deepEqual(parseChart(chart('USD')), [
        { date: '2026-10-14', close: '149.499992', currency: 'USD' },
        { date: '2026-10-15', close: '150', currency: 'USD' },
    ]);
    assert.equal(parseChart(chart('GBp'))[1].close, '1.5', 'pence become pounds');
    assert.equal(parseChart(chart('GBp'))[1].currency, 'GBP');
    assert.throws(() => parseChart({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } }), /delisted/);
});

test('Freedom24 tickers suggest Yahoo symbols', () => {
    assert.equal(suggestSymbol({ symbol: 'VUAA.EU', currency: 'USD' }), 'VUAA.L');
    assert.equal(suggestSymbol({ symbol: 'VWCE.EU', currency: 'EUR' }), 'VWCE.DE');
    assert.equal(suggestSymbol({ symbol: 'VTI.US', currency: 'USD' }), 'VTI');
    assert.equal(suggestSymbol({ symbol: 'IWDA.AS', currency: 'EUR' }), 'IWDA.AS');
});

test('ECB rates are read from the data-only CSV', () => {
    assert.deepEqual(parseCsv('KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-15,1.1186\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-16,NaN\n'),
        [{ currency: 'USD', date: '2026-10-15', perEur: '1.1186' }]);
    assert.deepEqual(parseCsv(''), []);
});

test('rates and prices fall back to the last working day', () => {
    const eurPer = createRates([{ currency: 'USD', date: '2026-10-15', perEur: '1.25' }, { currency: 'USD', date: '2026-10-16', perEur: '1.6' }]);
    assert.equal(fixed(eurPer('USD', '2026-10-18'), 4), '0.6250', 'Sunday uses Friday');
    assert.equal(fixed(eurPer('USD', '2026-10-15'), 4), '0.8000');
    assert.equal(eurPer('USD', '2026-10-14'), null, 'nothing before the first rate');
    assert.equal(fixed(eurPer('EUR', '2000-01-01')), '1.00');
    const priceOf = createPrices([{ instrumentId: 1, date: '2026-10-15', close: '149.5', currency: 'USD' }]);
    assert.equal(priceOf(1, '2026-10-17').date, '2026-10-15');
    assert.equal(priceOf(2), null);
});

async function imported() {
    const data = createMemoryData();
    await applyImport(await planImport(parseStatement(REPORT), data), data);
    return data;
}

test('the portfolio is valued at the latest prices and rates', async () => {
    const data = await imported();
    const id = symbol => data.instruments.find(i => i.symbol === symbol).id;
    const v = valuePortfolio({
        transactions: data.transactions.map(t => ({ ...t, account: t.accountId, instrument: t.instrumentId })),
        priceOf: createPrices([
            { instrumentId: id('VUAA.EU'), date: '2026-10-15', close: '149.5', currency: 'USD' },
            { instrumentId: id('VTI.US'), date: '2026-10-15', close: '377', currency: 'USD' },
        ]),
        // 1 EUR = 1.13 USD until 2026, then 1.12 (rounded to 8 decimals: 0.88495575 and 0.89285714 EUR per USD)
        eurPer: createRates([{ currency: 'USD', date: '2022-01-03', perEur: '1.13' }, { currency: 'USD', date: '2026-10-14', perEur: '1.12' }]),
        today: '2026-10-17',
    });
    const vuaa = v.positions.find(p => p.instrument === id('VUAA.EU'));
    // 6 × 149.5 = 897 USD × 0.89285714 = 800.89 EUR, against a cost of 433.326
    assert.deepEqual([fixed(vuaa.valueEur), fixed(vuaa.unrealisedEur)], ['800.89', '367.57']);
    assert.ok(vuaa.xirr > 0.1 && vuaa.xirr < 0.3, String(vuaa.xirr));
    // VTI's dividend had no rate in the statement: the ECB's fills it in. 0.55 USD × 0.88495575
    assert.equal(fixed(v.positions.find(p => p.instrument === id('VTI.US')).dividendsEur), '0.49');
    // 1000 EUR in; 50 USD out and 60 back (in 2023); 100 USD withdrawn (2024), all at 1.13
    assert.equal(fixed(v.total.investedEur), '920.35');
    const parts = v.positions.filter(p => p.open).reduce((s, p) => s + p.valueEur, 0n) + v.cash.reduce((s, c) => s + c.valueEur, 0n);
    assert.equal(v.total.valueEur, parts);
    assert.equal(fixed(v.total.gainEur), fixed(v.total.valueEur - v.total.investedEur));
    assert.ok(v.total.xirr > 0, String(v.total.xirr));
    assert.equal(v.pricesAsOf, '2026-10-15');
    assert.deepEqual(v.missingPrices, []);
});

// A stand-in for fetch that answers like Yahoo Finance and the ECB, and records the requests
function fakeNet({ failSymbol } = {}) {
    const requests = [];
    const fetch = async url => {
        requests.push(url);
        if (url.includes('finance.yahoo.com')) {
            const symbol = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
            if (symbol === failSymbol) return Response.json({ chart: { result: null, error: { description: 'Not found' } } }, { status: 404 });
            return Response.json({ chart: { result: [{ meta: { currency: 'USD', exchangeTimezoneName: 'America/New_York' }, timestamp: [1792008000], indicators: { quote: [{ close: [100] }] } }] } });
        }
        return new Response('KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\nX,D,USD,EUR,SP00,A,2026-10-14,1.12\n');
    };
    return { fetch, requests };
}

test('an update fetches prices for what is held, from the first purchase, then only what is new', async () => {
    const data = await imported();
    const net = fakeNet();
    const now = () => Date.parse('2026-10-15T20:00:00Z');
    const result = await updateMarketData(data, { fetch: net.fetch, now, log: () => {} });
    assert.deepEqual(result.problems, []);

    const symbols = Object.fromEntries(data.instruments.map(i => [i.symbol, i.priceSymbol]));
    assert.deepEqual(symbols, { 'VUAA.EU': 'VUAA.L', 'OCGN.US': null, 'CLSK.US': null, 'VTI.US': 'VTI' }, 'sold instruments are skipped');
    const yahoo = net.requests.filter(u => u.includes('yahoo'));
    assert.equal(yahoo.length, 2);
    assert.match(yahoo.find(u => u.includes('VUAA.L')), /VUAA\.L\?period1=1643068800&/, 'from the first VUAA trade, 2022-01-25');
    assert.match(net.requests.find(u => u.includes('ecb')), /D\.USD\.EUR\.SP00\.A\?startPeriod=2021-12-31/, 'rates from the first ledger row');
    assert.equal(data.prices.length, 2);
    assert.equal(data.fxRates.length, 1);
    assert.equal(data.status.prices.ok, true);

    net.requests.length = 0;
    await updateMarketData(data, { fetch: net.fetch, now, log: () => {} });
    assert.ok(net.requests.filter(u => u.includes('yahoo')).every(u => u.includes('period1=1792022400')), 'from the day after the last price');
    assert.match(net.requests.find(u => u.includes('ecb')), /startPeriod=2026-10-15/);
});

test('a failing symbol is reported, and a fresh check isn\'t repeated', async () => {
    const data = await imported();
    const net = fakeNet({ failSymbol: 'VTI' });
    const result = await updateMarketData(data, { fetch: net.fetch, now: () => Date.parse('2026-10-15T20:00:00Z'), log: () => {} });
    assert.match(result.problems[0], /VTI\.US \(VTI on Yahoo Finance\): Not found/);
    assert.equal(data.status.prices.ok, false);
    assert.equal(data.prices.length, 1, 'the other one still saved');

    const updater = createMarketUpdater(data, { fetch: net.fetch, log: () => {} });
    assert.equal(await updater.refreshIfStale(), false, 'checked moments ago');
});
