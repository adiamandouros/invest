import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixed } from '../server/lib/decimal.js';
import { createInflation } from '../server/lib/inflation.js';
import { createReports } from '../server/lib/reports.js';
import { createPrices, createRates } from '../server/lib/valuation.js';
import { fetchPriceIndex } from '../server/market/ecb.js';
import { updateMarketData } from '../server/market/update.js';
import { signUp, start } from './helpers/app.js';
import { fixture } from './helpers/portfolio.js';

const INDEX = [{ month: '2023-12', index: '100' }, { month: '2024-06', index: '104' }, { month: '2024-12', index: '110' }, { month: '2025-12', index: '115.5' }];

test('prices\' rise between days, from a monthly index', () => {
    const i = createInflation(INDEX);
    assert.equal(i.lastMonth, '2025-12');
    assert.equal(i.between('2023-12-31', '2024-12-31').toFixed(4), '0.1000');
    assert.equal(i.between('2024-12-31', '2026-10-15').toFixed(4), '0.0500', 'months not published yet count as no rise');
    assert.equal(i.factor('2024-06-15', '2024-12-31').toFixed(4), (110 / 104).toFixed(4));
    assert.equal(i.real(0.21, 0.1).toFixed(4), '0.1000');
    assert.equal(i.real(null, 0.1), null);
    assert.equal(createInflation([]), null);
});

test('the reports with inflation: each year\'s rise and real return, and the real yearly rate', async () => {
    const data = await fixture();
    const reportsOf = inflation => createReports({
        transactions: data.transactions, accounts: new Map(data.accounts.map(a => [a.id, a])), instruments: new Map(data.instruments.map(i => [i.id, i])),
        balances: data.balances, groups: data.groups, priceOf: createPrices(data.prices), eurPer: createRates([]), today: '2025-12-31', inflation,
    });
    const r = reportsOf(createInflation(INDEX));
    const y24 = r.year(2024);
    assert.equal(y24.inflation.toFixed(4), '0.1000');
    assert.equal(y24.realReturn.toFixed(6), ((1 + y24.periodReturn) / 1.1 - 1).toFixed(6));
    const t = r.total();
    assert.ok(t.realXirr < t.xirr, `${t.realXirr} < ${t.xirr}`);
    assert.equal(t.inflationUntil, '2025-12');
    const none = reportsOf(null);
    assert.equal(none.year(2024).inflation, null);
    assert.equal(none.total().realXirr, null);
    assert.equal(fixed(none.total().endValue), fixed(t.endValue), 'the money figures stay the same');
});

test('the ECB\'s consumer prices are read, and fetched with each update', async () => {
    const requests = [];
    const fetch = async url => {
        requests.push(url);
        if (url.includes('/ICP/')) return new Response('KEY,FREQ,REF_AREA,ADJUSTMENT,ICP_ITEM,STS_INSTITUTION,ICP_SUFFIX,TIME_PERIOD,OBS_VALUE\nICP.M.GR.N.000000.4.INX,M,GR,N,000000,4,INX,2024-01,108.5\nICP.M.GR.N.000000.4.INX,M,GR,N,000000,4,INX,2024-02,109.1\n');
        if (url.includes('yahoo')) return Response.json({ chart: { result: [{ meta: { currency: 'EUR', exchangeTimezoneName: 'Europe/Berlin' }, timestamp: [], indicators: { quote: [{ close: [] }] } }] } });
        return new Response('KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\n');
    };
    assert.deepEqual(await fetchPriceIndex('GR', '2024-01', { fetch }), [{ area: 'GR', month: '2024-01', index: '108.5' }, { area: 'GR', month: '2024-02', index: '109.1' }]);
    assert.match(requests[0], /\/ICP\/M\.GR\.N\.000000\.4\.INX\?startPeriod=2024-01/);

    const data = await fixture();
    requests.length = 0;
    await updateMarketData(data, { fetch, now: () => Date.parse('2025-12-31T12:00:00Z'), log: () => {} });
    assert.match(requests.find(u => u.includes('/ICP/')), /startPeriod=2023-12/, 'from the December before the first row');
    assert.equal(data.priceIndex.length, 2);
    assert.equal(data.status.inflation.ok, true);
    requests.length = 0;
    await updateMarketData(data, { fetch, now: () => Date.parse('2025-12-31T12:00:00Z'), log: () => {} });
    assert.match(requests.find(u => u.includes('/ICP/')), /startPeriod=2024-03/, 'then only the months after the last one');
});

test('the pages after inflation', async () => {
    const data = await fixture();
    await data.savePriceIndex(INDEX.map(r => ({ area: 'GR', ...r })));
    const app = await start({ data });
    app.clock.now = Date.parse('2025-12-31T12:00:00Z');
    try {
        const b = app.browser();
        await signUp(b, app.clock);
        const reports = await (await b.get('/reports')).text();
        assert.match(reports, /<dt>Return a year after inflation<\/dt>/);
        assert.match(reports, /<th scope="col" class="text-end">Prices rose<\/th>/);
        assert.match(reports, /known up to 2025-12/);
        assert.match(await (await b.get('/reports/2024')).text(), /<dt>Prices rose<\/dt><dd>\+10\.0%<\/dd>/);
        assert.match(await (await b.get('/')).text(), /after inflation<\/span>/);
        // 632.96 at 0% for 2 years, prices up 10% a year: 632.96 / 1.21 = 523 in today's money
        const projection = await (await b.get('/projection?years=2&monthly=0&rate-1=0&rate-2=0&inflation=10')).text();
        assert.match(projection, /<dt>In today&#39;s money<\/dt><dd>€523<\/dd>|<dt>In today's money<\/dt><dd>€523<\/dd>/);
        assert.equal((await b.get('/projection?years=2&monthly=0&rate-1=0&rate-2=0&inflation=x')).status, 400);
    } finally {
        app.close();
    }
});
