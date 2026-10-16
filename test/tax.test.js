import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dec, fixed } from '../server/lib/decimal.js';
import { DEFAULT_RATE, isUcits, taxYear } from '../server/lib/tax.js';
import { createRates } from '../server/lib/valuation.js';
import { taxCsv } from '../server/portfolio/tax-views.js';
import { location, signUp, start } from './helpers/app.js';
import { fixture } from './helpers/portfolio.js';

// test/helpers/portfolio.js, by hand:
//   2024: PeerBerry interest 2.55, nothing withheld; the ETF only bought
//   2025: Mintos interest 5.722346, 0.26 withheld, 0.05 fees; the ETF paid 2 and sold 5 for a 24.50 gain
//   Greek tax at 15%: 5.722346 × 0.15 = 0.858352, less 0.26 withheld = 0.598352
async function yearOf(year, rate = DEFAULT_RATE) {
    const data = await fixture();
    return taxYear({
        transactions: await data.listTransactions(), accounts: new Map(data.accounts.map(a => [a.id, a])),
        instruments: new Map(data.instruments.map(i => [i.id, i])), eurPer: createRates([]), year, rate,
    });
}
const f = v => fixed(v, 6);

test('P2P interest per platform, tax withheld abroad, and the Greek tax left to pay', async () => {
    const t = await yearOf(2025);
    assert.deepEqual(t.p2p.map(p => [p.account.name, f(p.interest), f(p.withheld), f(p.greekTax), f(p.credit), f(p.due), f(p.fees)]),
        [['Mintos', '5.722346', '0.260000', '0.858352', '0.260000', '0.598352', '0.050000']], 'PeerBerry had nothing in 2025');
    assert.equal(f(t.p2pTotal.due), '0.598352');

    const y24 = await yearOf(2024);
    assert.deepEqual(y24.p2p.map(p => [p.account.name, fixed(p.interest), fixed(p.due)]), [['PeerBerry', '2.55', '0.38']]);

    // Withheld abroad counts only up to the Greek tax
    const low = await yearOf(2025, dec('0.02'));
    assert.deepEqual([f(low.p2pTotal.greekTax), f(low.p2pTotal.credit), f(low.p2pTotal.due)], ['0.114447', '0.114447', '0.000000']);
});

test('ETFs: dividends and realised gains, for the records', async () => {
    assert.deepEqual((await yearOf(2025)).etfs.map(e => [e.instrument.symbol, fixed(e.dividends), fixed(e.realised), e.sold]), [['ETF', '2.00', '24.50', true]]);
    assert.deepEqual((await yearOf(2024)).etfs, [], 'bought only: nothing to show');
    const csv = taxCsv(await yearOf(2025)).split('\r\n');
    assert.equal(csv[0], 'Tax summary 2025,Greek tax on interest 15%,on dividends 5%');
    assert.ok(csv.includes('Mintos,5.72,0.26,0.86,0.26,0.60,0.05'));
    assert.ok(csv.includes('ETF,,Not sure,2.00,0.00,24.50,,,'), 'no ISIN: not sure whether it is UCITS');
});

test('UCITS funds are told from the rest by their ISIN', () => {
    assert.equal(isUcits({ kind: 'etf', isin: 'IE00BFMXXD54' }), true);
    assert.equal(isUcits({ kind: 'etf', isin: 'US9229087690' }), false);
    assert.equal(isUcits({ kind: 'etf', isin: 'KY0000000000' }), null);
    assert.equal(isUcits({ kind: 'etf', isin: null }), null);
    assert.equal(isUcits({ kind: 'stock', isin: 'US18452B2097' }), false);
});

test('dividends from outside UCITS: Greek tax at 5%, less what was withheld abroad', () => {
    const instruments = new Map([[1, { id: 1, symbol: 'VTI.US', name: 'US fund', isin: 'US9229087690', kind: 'etf' }], [2, { id: 2, symbol: 'VWRA', name: 'UCITS fund', isin: 'IE00BK5BQT80', kind: 'etf' }]]);
    const row = t => ({ accountId: 1, units: null, price: null, fee: '0', feeCurrency: null, fxToEur: '1', currency: 'EUR', notes: null, importRef: null, ...t });
    const transactions = [
        row({ id: 1, instrumentId: 1, type: 'dividend', date: '2025-03-01', amount: '10' }),
        row({ id: 2, instrumentId: 1, type: 'tax', date: '2025-03-01', amount: '-3' }),
        row({ id: 3, instrumentId: 2, type: 'dividend', date: '2025-04-01', amount: '20' }),
        row({ id: 4, instrumentId: 1, type: 'dividend', date: '2025-06-01', amount: '40' }),
    ];
    const t = taxYear({ transactions, accounts: new Map([[1, { id: 1, kind: 'broker', name: 'Broker' }]]), instruments, eurPer: createRates([]), year: 2025, rate: DEFAULT_RATE });
    assert.deepEqual(t.taxed.map(e => [e.instrument.symbol, fixed(e.dividends), fixed(e.dividendTax), fixed(e.credit), fixed(e.due)]),
        [['VTI.US', '50.00', '2.50', '2.50', '0.00']], 'only the US fund; 3 withheld covers the 2.50');
    assert.equal(t.etfs.find(e => e.instrument.symbol === 'VWRA').dividendTax, null, 'the UCITS fund is tax-free');
    const partly = taxYear({ transactions: transactions.filter(r => r.id !== 2), accounts: new Map(), instruments, eurPer: createRates([]), year: 2025, rate: DEFAULT_RATE });
    assert.equal(fixed(partly.taxedTotal.due), '2.50', 'nothing withheld: all of it');
});

test('the tax pages', async () => {
    const app = await start({ data: await fixture() });
    app.clock.now = Date.parse('2025-12-31T12:00:00Z');
    try {
        const b = app.browser();
        assert.equal(location(await b.get('/tax/2025')), '/login');
        await signUp(b, app.clock);
        assert.equal(location(await b.get('/tax')), '/tax/2024', 'the last whole year');
        const html = await (await b.get('/tax/2025')).text();
        assert.match(html, /<h1 class="fs-3">Tax summary 2025<\/h1>/);
        assert.match(html, /href="\/tax" aria-current="page"/, 'Tax is marked in the menu');
        assert.match(html, /Greek tax at 15%/);
        assert.match(html, /href="\/tax\/2024">2024/);
        assert.match(await (await b.get('/tax/2025?rate=20')).text(), /Greek tax at 20%/);
        assert.match(await (await b.get('/tax/2025?dividendRate=8')).text(), /Greek tax on dividends \(%\)/);
        const bad = await b.get('/tax/2025?rate=abc');
        assert.equal(bad.status, 400);
        assert.match(await bad.text(), /Enter a percentage from 0 to 100/);
        const csv = await b.get('/tax/2025.csv?rate=15');
        assert.match(csv.headers.get('content-disposition'), /invest-tax-2025\.csv/);
        assert.equal((await b.get('/tax/2019')).status, 404);
        assert.equal((await b.get('/tax/2026')).status, 404, 'not a year yet');
        assert.match(await (await b.get('/reports/2025')).text(), /href="\/reports" aria-current="page"/);
    } finally {
        app.close();
    }
});
