import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixed } from '../server/lib/decimal.js';
import { createReports } from '../server/lib/reports.js';
import { createPrices, createRates } from '../server/lib/valuation.js';
import { yearCsv, yearsCsv } from '../server/portfolio/reports-views.js';
import { csrfOf, location, signUp, start } from './helpers/app.js';
import { fixture } from './helpers/portfolio.js';

const reportsOf = async (data, today = '2025-12-31') => createReports({
    transactions: await data.listTransactions(),
    accounts: new Map((await data.listAccounts()).map(a => [a.id, a])),
    instruments: new Map((await data.listInstruments()).map(i => [i.id, i])),
    balances: await data.listBalances(), groups: await data.listGroups(),
    priceOf: createPrices(await data.listPrices()), eurPer: createRates([]), today,
});
const money = v => (v === null ? null : fixed(v, 6));

test('each year: values at the start and end, money put in, gain, and income', async () => {
    const r = await reportsOf(await fixture());
    assert.deepEqual(r.years, [2025, 2024]);
    const y24 = r.year(2024);
    assert.deepEqual([y24.from, y24.to], ['2023-12-31', '2024-12-31']);
    assert.deepEqual([y24.startValue, y24.endValue, y24.putIn, y24.gain, y24.interest, y24.fees].map(money),
        ['0.000000', '272.550000', '251.000000', '21.550000', '2.550000', '-1.000000']);
    assert.deepEqual(y24.holdings.map(h => [h.name, money(h.startValue), money(h.putIn), money(h.gain), money(h.endValue)]), [
        ['ETF', '0.000000', '101.000000', '19.000000', '120.000000'],
        ['PeerBerry', '0.000000', '150.000000', '2.550000', '152.550000'],
    ]);
    assert.equal(money(y24.rest), '0.000000', 'the holdings add up to the total');
    assert.ok(y24.periodReturn > 0.05 && y24.periodReturn < 0.15, `about 9%, got ${y24.periodReturn}`);

    const y25 = r.year(2025);
    assert.deepEqual([y25.startValue, y25.endValue, y25.putIn, y25.gain, y25.realised, y25.dividends, y25.interest, y25.tax, y25.fees].map(money),
        ['272.550000', '709.962346', '400.000000', '37.412346', '24.500000', '2.000000', '5.722346', '-0.260000', '-0.050000']);
    assert.deepEqual(y25.holdings.map(h => [h.name, money(h.gain)]), [['ETF', '32.000000'], ['Mintos', '5.412346'], ['PeerBerry', '0.000000']]);
    assert.equal(money(y25.rest), '0.000000');
    assert.deepEqual(y25.groups.list.map(g => [g.name, money(g.value), g.share.toFixed(4)]),
        [['ETFs', '75.000000', '0.1185'], ['P2P', '557.962346', '0.8815']], 'cash at the broker is in no group');
});

test('the total report covers everything, with the yearly rate', async () => {
    const r = await reportsOf(await fixture());
    const t = r.total();
    assert.equal(r.firstDate, '2024-02-01');
    assert.deepEqual([t.startValue, t.endValue, t.putIn, t.gain, t.realised].map(money), ['0.000000', '709.962346', '651.000000', '58.962346', '24.500000']);
    assert.ok(t.xirr > 0.03 && t.xirr < 0.15, `got ${t.xirr}`);

    // The current year ends today
    const partly = (await reportsOf(await fixture(), '2025-04-30')).year(2025);
    assert.equal(partly.to, '2025-04-30');
    assert.equal(money(partly.dividends), '2.000000');
    assert.equal(money(partly.realised), '0.000000');
});

test('the CSV downloads', async () => {
    const r = await reportsOf(await fixture());
    const years = yearsCsv(r.years.map(r.year)).split('\r\n');
    assert.match(years[0], /^Year,From,To,Value at start \(EUR\)/);
    assert.match(years[2], /^2024,2023-12-31,2024-12-31,0\.00,251\.00,21\.55,[\d.]+,272\.55,2\.55,0\.00,0\.00,0\.00,-1\.00$/);
    assert.match(yearCsv(r.year(2025)), /\r\n"Cash, currency moves and fees",,,0\.00,\r\nTotal,272\.55,400\.00,37\.41,709\.96\r\n/);
});

test('the report pages', async () => {
    const app = await start({ data: await fixture() });
    app.clock.now = Date.parse('2025-12-31T12:00:00Z');
    try {
        const b = app.browser();
        assert.equal(location(await b.get('/reports')), '/login');
        await signUp(b, app.clock);
        const page = await (await b.get('/reports')).text();
        assert.match(page, /Everything so far, since 2024-02-01/);
        assert.match(page, /href="\/reports\/2024">2024/);
        assert.match(page, /<canvas id="groups-now" data-chart="groups-now-data" role="img" aria-label="Allocation now: ETFs 11\.8%, P2P 88\.2%"/);
        assert.match(page, /<script type="application\/json" id="groups-years-data">/);
        assert.match(page, /\/vendor\/chart\.js\/chart\.umd\.min\.js\?v=/);
        assert.match(await (await b.get('/reports/2025')).text(), /<h1 class="fs-3">2025<\/h1>/);
        const csv = await b.get('/reports/2024.csv');
        assert.match(csv.headers.get('content-disposition'), /invest-2024\.csv/);
        const bytes = Buffer.from(await csv.arrayBuffer());
        assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'a BOM, so Excel reads it as UTF-8');
        assert.match(bytes.toString('utf8', 3), /^Holding,/);
        assert.equal((await b.get('/reports/2019')).status, 404);
        assert.equal((await b.get('/reports.csv')).status, 200);
        assert.equal((await b.get('/vendor/chart.js/chart.umd.min.js')).status, 200);
    } finally {
        app.close();
    }
});
