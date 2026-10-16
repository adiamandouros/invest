import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixed } from '../server/lib/decimal.js';
import { benchmark } from '../server/lib/benchmark.js';
import { createRates } from '../server/lib/valuation.js';
import { csrfOf, location, signUp, start } from './helpers/app.js';
import { fixture } from './helpers/portfolio.js';

const row = t => ({ accountId: 1, instrumentId: null, units: null, price: null, fee: '0', feeCurrency: null, fxToEur: '1', currency: 'EUR', notes: null, ...t });
const PRICES = [{ date: '2023-12-01', close: '10', currency: 'EUR' }, { date: '2024-07-01', close: '20', currency: 'EUR' }, { date: '2024-12-31', close: '30', currency: 'EUR' }];

test('the same money in and out, in the benchmark instead', () => {
    // 100 in at 10 = 10 units; 50 out at 20 = 2.5 units sold; 7.5 units at 30 = 225
    const transactions = [row({ type: 'deposit', date: '2024-01-01', amount: '100' }), row({ type: 'withdrawal', date: '2024-07-01', amount: '-50' }),
        row({ type: 'interest', date: '2024-08-01', amount: '5' })];
    const b = benchmark({ transactions, prices: PRICES, eurPer: createRates([]), today: '2024-12-31', dates: ['2024-01-31', '2024-07-31', '2024-12-31'] });
    assert.equal(fixed(b.value), '225.00');
    assert.deepEqual(b.series.map(p => fixed(p.value)), ['100.00', '150.00', '225.00'], 'interest is earned, not put in: no change');
    assert.ok(b.xirr > 1.5, `a big gain: ${b.xirr}`);

    // Before the first price, money buys at the first price
    const early = benchmark({ transactions: [row({ type: 'deposit', date: '2020-01-01', amount: '100' })], prices: PRICES, eurPer: createRates([]), today: '2024-12-31' });
    assert.equal(fixed(early.value), '300.00');
    assert.equal(early.firstPrice, '2023-12-01');

    // Prices in USD use the ECB rate on each day
    const usd = benchmark({
        transactions: [row({ type: 'deposit', date: '2024-01-01', amount: '100' })], today: '2024-12-31',
        prices: [{ date: '2024-01-01', close: '10', currency: 'USD' }, { date: '2024-12-31', close: '10', currency: 'USD' }],
        eurPer: createRates([{ currency: 'USD', date: '2024-01-01', perEur: '1' }, { currency: 'USD', date: '2024-12-31', perEur: '1.25' }]),
    });
    assert.equal(fixed(usd.value), '80.00', 'the same price in USD is worth less in EUR');
    assert.equal(benchmark({ transactions: [], prices: [], eurPer: createRates([]), today: '2024-12-31' }), null);
});

test('choosing a benchmark, then the comparison on the overview and the reports', async () => {
    const app = await start({ data: await fixture() });
    app.clock.now = Date.parse('2025-12-31T12:00:00Z');
    try {
        const b = app.browser();
        await signUp(b, app.clock);
        assert.match(await (await b.get('/')).text(), /href="\/reports#benchmark-heading">Compare with a benchmark/);
        const reports = await (await b.get('/reports')).text();
        assert.match(reports, /id="benchmark-symbol" name="symbol" type="text" class="form-control" value="VWCE.DE"/);

        assert.equal(location(await b.post('/benchmark', { _csrf: csrfOf(reports), symbol: 'not a symbol!' })), '/reports?benchmark=invalid#benchmark-heading');
        assert.equal(location(await b.post('/benchmark', { _csrf: csrfOf(reports), symbol: 'vwce.de' })), '/reports#benchmark-heading');
        const chosen = app.data.instruments.find(i => i.priceSymbol === 'VWCE.DE');
        assert.equal(chosen.name, 'VWCE.DE (benchmark)');
        assert.equal(app.data.settingsStore.benchmark_instrument, String(chosen.id));
        assert.match(await (await b.get('/reports')).text(), /No prices for VWCE\.DE yet/);

        // Flat at 10 throughout: the 651 put in is worth 651 in the benchmark
        await app.data.savePrices([{ instrumentId: chosen.id, date: '2024-01-02', close: '10', currency: 'EUR', source: 'yahoo' }]);
        const overview = await (await b.get('/')).text();
        assert.match(overview, /If every euro you put in had gone into VWCE\.DE, you&#39;d have €651\.00|If every euro you put in had gone into VWCE\.DE, you'd have €651\.00/);
        assert.match(overview, /you&#39;re €58\.96 ahead|you're €58\.96 ahead/);
        assert.match(overview, /"name":"All in VWCE\.DE"/);
        const withBench = await (await b.get('/reports')).text();
        assert.match(withBench, /<dt>All in VWCE\.DE<\/dt><dd>€651\.00<\/dd>/);
        assert.match(withBench, /<dt>Ahead of it by<\/dt><dd>€58\.96<\/dd>/);
        assert.equal(app.data.instruments.filter(i => i.priceSymbol === 'VWCE.DE').length, 1);
        await b.post('/benchmark', { _csrf: csrfOf(reports), symbol: 'VWCE.DE' });
        assert.equal(app.data.instruments.filter(i => i.priceSymbol === 'VWCE.DE').length, 1, 'chosen again: the same one');
    } finally {
        app.close();
    }
});
