import { test } from 'node:test';
import assert from 'node:assert/strict';
import { location, signUp, start } from './helpers/app.js';
import { fixture } from './helpers/portfolio.js';

// test/helpers/portfolio.js: an EUR ETF, 10 bought at 10 (fee 1) in March 2024, 5 sold at 15
// in June 2025, closes 12 (end of 2024) and 15 (June 2025)
test('a holding\'s page: figures, price chart with the trades, and its transactions', async () => {
    const app = await start({ data: await fixture() });
    app.clock.now = Date.parse('2025-12-31T12:00:00Z');
    try {
        const b = app.browser();
        const etf = app.data.instruments.find(i => i.symbol === 'ETF');
        assert.equal(location(await b.get(`/holdings/${etf.id}`)), '/login');
        await signUp(b, app.clock);

        const holdings = await (await b.get('/holdings')).text();
        assert.match(holdings, new RegExp(`<a href="/holdings/${etf.id}">ETF</a>`), 'the holdings link to it');
        const html = await (await b.get(`/holdings/${etf.id}`)).text();
        assert.match(html, /<h1 class="fs-3">ETF<\/h1>/);
        assert.match(html, /href="\/holdings" aria-current="page"/);
        assert.match(html, /<dt>Units<\/dt><dd>5<\/dd>/);
        assert.match(html, /<dt>Value now<\/dt><dd>€75\.00<\/dd>/);
        assert.match(html, /<dt>Gain from sales<\/dt><dd>\+€24\.50<\/dd>/);
        const data = JSON.parse(html.match(/<script type="application\/json" id="price-chart-data">(.*?)<\/script>/)[1]);
        assert.deepEqual([data.type, data.currency, data.dates, data.closes], ['price', 'EUR', ['2024-12-31', '2025-06-30'], [12, 15]]);
        assert.deepEqual(data.buys, [{ date: '2024-03-01', price: 10, units: 10 }]);
        assert.deepEqual(data.sells, [{ date: '2025-06-30', price: 15, units: 5 }]);
        assert.deepEqual(data.averages, [{ date: '2024-03-01', value: 10 }, { date: '2025-06-30', value: 10 }], 'FIFO: the same lot');
        assert.match(html, /aria-label="ETF&#39;s closing price in EUR from 2024-12-31 to 2025-06-30, now 15\.00, with your 1 buys and 1 sales marked and your average cost a unit/);
        assert.match(html, /Transactions, newest first/);
        assert.equal((await b.get('/holdings/999')).status, 404);
    } finally {
        app.close();
    }
});
