import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixed } from '../server/lib/decimal.js';
import { createReports } from '../server/lib/reports.js';
import { createPrices, createRates } from '../server/lib/valuation.js';
import { dashboardNotices } from '../server/portfolio/dashboard-views.js';
import { location, signUp, start } from './helpers/app.js';
import { fixture } from './helpers/portfolio.js';

// test/helpers/portfolio.js: an ETF from February 2024, PeerBerry in 2024, Mintos in 2025

test('the value and money put in at the end of each month, and income per month', async () => {
    const data = await fixture();
    const r = createReports({
        transactions: await data.listTransactions(), accounts: new Map(data.accounts.map(a => [a.id, a])),
        instruments: new Map(data.instruments.map(i => [i.id, i])), balances: data.balances, groups: data.groups,
        priceOf: createPrices(data.prices), eurPer: createRates([]), today: '2025-12-20',
    });
    const series = r.series();
    assert.equal(series.length, 23, 'February 2024 to December 2025');
    assert.deepEqual(series.map(p => [p.month, p.date, p.investedEur === null ? null : fixed(p.investedEur)]).filter((_, i) => [0, 1, 22].includes(i)),
        [['2024-02', '2024-02-29', '101.00'], ['2024-03', '2024-03-31', '101.00'], ['2025-12', '2025-12-20', '651.00']]);
    assert.equal(series[0].valueEur, 10100000000n, 'the deposit, as cash');
    assert.equal(series[1].valueEur, null, 'no price for the ETF before 31 December 2024');
    assert.equal(fixed(series.at(-1).valueEur, 6), '709.962346');

    const income = new Map(r.income().map(m => [m.month, m]));
    assert.deepEqual(['interest', 'dividends', 'tax'].map(k => fixed(income.get('2025-03')[k], 4)), ['1.2100', '2.0000', '-0.0600']);
    assert.equal(fixed(income.get('2024-05').interest), '0.80');
});

test('what needs a look: old prices, failed updates, old P2P statements, holdings in no group', () => {
    const v = { missingPrices: [3], pricesAsOf: '2025-12-01' };
    const notices = dashboardNotices({
        valuation: v, instruments: new Map([[3, { symbol: 'XYZ' }]]), today: '2025-12-20', updating: true,
        status: { prices: { ok: false, message: 'XYZ: not found' } },
        p2p: [{ account: { name: 'Mintos' }, lastDate: '2025-10-01' }, { account: { name: 'PeerBerry' }, lastDate: '2025-12-15' }],
        unassigned: [{ name: 'VTI.US' }],
    }).join('\n');
    assert.match(notices, /Updating prices/);
    assert.match(notices, /had problems: XYZ: not found/);
    assert.match(notices, /No price yet for <a href="\/instruments\/3\/edit">XYZ<\/a>/);
    assert.match(notices, /from 2025-12-01, 19 days ago/);
    assert.match(notices, /Mintos's newest row is from 2025-10-01\. <a href="\/import">Import a newer statement<\/a> to bring it up to date/);
    assert.doesNotMatch(notices, /PeerBerry's newest/);
    assert.match(notices, /Not in an allocation group: VTI\.US/);
});

test('the overview page', async () => {
    const app = await start({ data: await fixture() });
    app.clock.now = Date.parse('2025-12-31T12:00:00Z');
    try {
        const b = app.browser();
        assert.equal(location(await b.get('/')), '/login');
        await signUp(b, app.clock);
        const html = await (await b.get('/')).text();
        assert.match(html, /<title>Overview — Invest<\/title>/);
        assert.match(html, /href="\/" aria-current="page"/);
        assert.match(html, /<dt>Value now<\/dt><dd>€709\.96<\/dd>/);
        assert.match(html, /<dt>Put in<\/dt><dd>€651\.00<\/dd>/);
        assert.match(html, /This year, so far/);
        assert.match(html, /href="\/reports\/2025">This year in detail/);
        assert.match(html, /<script type="application\/json" id="value-chart-data">\{"id":"value-chart","type":"line"/);
        assert.match(html, /<script type="application\/json" id="income-chart-data">/);
        assert.match(html, /<summary>The figures, newest first<\/summary>/);
        assert.match(html, /Allocation now: ETFs 11\.8%, P2P 88\.2%/);
        assert.match(html, /Mintos's newest row is from 2025-03-31/);
    } finally {
        app.close();
    }

    const empty = await start();
    try {
        const b = empty.browser();
        await signUp(b, empty.clock);
        const html = await (await b.get('/')).text();
        assert.match(html, /Nothing recorded yet/);
        assert.doesNotMatch(html, /chart\.umd/);
    } finally {
        empty.close();
    }
});

test('a group more than 5 points from its target is pointed out', async () => {
    const { allocation } = await import('../server/lib/allocation.js');
    const { dec } = await import('../server/lib/decimal.js');
    const groups = [{ id: 1, name: 'S&P 500', targetPct: '60' }, { id: 2, name: 'International', targetPct: '10' }, { id: 3, name: 'P2P', targetPct: '30' }];
    const items = values => values.map(([groupId, v], i) => ({ key: `k${i}`, name: `k${i}`, groupId, valueEur: dec(v) }));
    const notices = a => dashboardNotices({ valuation: { missingPrices: [], pricesAsOf: null }, instruments: new Map(), today: '2026-10-16', allocation: a }).join('');

    const drifted = notices(allocation({ groups, items: items([[1, '67'], [2, '19'], [3, '14']]) }));
    assert.match(drifted, /Your allocation has drifted: S&amp;P 500 is at 67\.0% against a 60% target \(\+7\.0 points\); International is at 19\.0% against a 10% target \(\+9\.0 points\); P2P is at 14\.0% against a 30% target \(−16\.0 points\)/);
    assert.match(drifted, /href="\/allocation">See how to split your next investment/);
    assert.equal(notices(allocation({ groups, items: items([[1, '64'], [2, '10'], [3, '26']]) })), '', 'within 5 points: nothing to say');
    assert.equal(notices(allocation({ groups: [{ ...groups[0], targetPct: '50' }], items: items([[1, '1']]) })), '', 'targets that don\'t add up: not ready');
});
