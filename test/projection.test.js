import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixed } from '../server/lib/decimal.js';
import { monthlyFor, project, spreadOf } from '../server/lib/projection.js';
import { createReports } from '../server/lib/reports.js';
import { createPrices, createRates } from '../server/lib/valuation.js';
import { location, signUp, start } from './helpers/app.js';
import { fixture } from './helpers/portfolio.js';

const close = (actual, expected, places = 2) => assert.equal(actual.toFixed(places), expected.toFixed(places));

test('growth at a yearly rate, compounded monthly, with money added each month', () => {
    const [now, one, two] = project({ years: 2, groups: [{ id: 1, name: 'A', value: 1000, rate: 0.1, spread: null, weight: 1 }] });
    assert.equal(now.total.mid, 1000);
    close(one.total.mid, 1100);
    close(two.total.mid, 1210);
    assert.equal(two.total.low, two.total.mid, 'no spread, no range');

    // 100 a month at 0%: just the sum; at 12% a year, the annuity formula
    close(project({ years: 1, monthlyAmount: 100, groups: [{ id: 1, name: 'A', value: 0, rate: 0, spread: null, weight: 1 }] })[1].total.mid, 1200);
    const m = 1.12 ** (1 / 12) - 1;
    close(project({ years: 1, monthlyAmount: 100, groups: [{ id: 1, name: 'A', value: 0, rate: 0.12, spread: null, weight: 1 }] })[1].total.mid, 100 * ((1 + m) ** 12 - 1) / m);
});

test('the monthly amount is shared by weight, and the spread gives a range', () => {
    const rows = project({
        years: 1, monthlyAmount: 100,
        groups: [{ id: 1, name: 'A', value: 600, rate: 0, spread: null, weight: 60 }, { id: 2, name: 'B', value: 300, rate: 0.1, spread: 0.05, weight: 30 }, { id: null, name: 'Other', value: 100, rate: 0, spread: null, weight: 0 }],
    });
    const [a, b, other] = rows[1].groups;
    close(a.mid, 600 + 12 * 66.67, 0);
    assert.equal(other.mid, 100, 'no money for holdings outside the groups');
    assert.ok(b.low < b.mid && b.mid < b.high);
    const m = 1.1 ** (1 / 12) - 1;
    close(b.mid, 300 * 1.1 + (100 / 3) * ((1 + m) ** 12 - 1) / m);
    assert.equal(rows[1].contributed, 1200);
    close(spreadOf([0.1, 0.2, 0.3]), 0.1, 6);
    assert.equal(spreadOf([0.1]), null);
});

test('each group\'s past: value now, return since the start, whole years only', async () => {
    const data = await fixture();
    const r = createReports({
        transactions: await data.listTransactions(), accounts: new Map(data.accounts.map(a => [a.id, a])),
        instruments: new Map(data.instruments.map(i => [i.id, i])), balances: data.balances, groups: await data.listGroups(),
        priceOf: createPrices(data.prices), eurPer: createRates([]), today: '2026-06-30',
    });
    const history = r.groupHistory();
    assert.deepEqual(history.map(g => [g.id, g.name, fixed(g.value, 2), g.years.map(y => y.year)]), [
        [1, 'ETFs', '75.00', [2025]],
        [2, 'P2P', '557.96', [2025]],
    ], 'bought in 2024, so 2024 is partial; broker cash is in no holding');
    // The ETF in 2025: 120 at the start, 2 dividend in March, 75 from the sale in June, 75 at the end
    // (152 back for 120, most of it mid-year: about 38%)
    assert.ok(history[0].years[0].rate > 0.35 && history[0].years[0].rate < 0.42, String(history[0].years[0].rate));
    assert.ok(history[0].xirr > 0, String(history[0].xirr));
});

test('the projection page: past returns prefilled, then your own', async () => {
    const app = await start({ data: await fixture() });
    app.clock.now = Date.parse('2026-06-30T12:00:00Z');
    try {
        const b = app.browser();
        assert.equal(location(await b.get('/projection')), '/login');
        await signUp(b, app.clock);
        const first = await (await b.get('/projection')).text();
        assert.match(first, /href="\/projection" aria-current="page"/);
        assert.match(first, /id="f-years" name="years" type="text" class="form-control" value="10"/);
        assert.match(first, /In 10 years, in 2036/);
        assert.match(first, /Shared out by your targets: ETFs 60%, P2P 40%\./);
        assert.match(first, /<script type="application\/json" id="projection-chart-data">/);

        const own = await (await b.get('/projection?years=2&monthly=100&rate-1=0&rate-2=0')).text();
        assert.match(own, /In 2 years, in 2028/);
        assert.match(own, /<dt>Projected value<\/dt><dd>€3,033<\/dd>/, '632.96 + 2,400 at 0%');
        assert.match(own, /<dt>Of which added<\/dt><dd>€2,400<\/dd>/);

        const bad = await b.get('/projection?years=0&monthly=x&rate-1=90&rate-2=5');
        assert.equal(bad.status, 400);
        const html = await bad.text();
        assert.match(html, /Enter a whole number of years from 1 to 50/);
        assert.match(html, /Enter an amount, or 0/);
        assert.match(html, /Enter a percentage from −50 to 50/);
        assert.doesNotMatch(html, /Projected value/);
    } finally {
        app.close();
    }
});

test('over more years the range narrows: the spread over √years', () => {
    const group = { id: 1, name: 'A', value: 1000, rate: 0.07, spread: 0.1, weight: 1 };
    const four = project({ years: 4, groups: [group] })[4].total;
    close(four.mid, 1000 * 1.07 ** 4);
    close(four.low, 1000 * 1.02 ** 4); // the spread halves over 4 years: 7% − 5%
    close(four.high, 1000 * 1.12 ** 4);
});

test('the monthly amount for a goal', () => {
    const flat = [{ id: 1, name: 'A', value: 0, rate: 0, spread: 0.1, weight: 1 }];
    close(monthlyFor({ groups: flat, years: 1, goal: 1200 }), 100);
    const m = 1.12 ** (1 / 12) - 1;
    const growing = [{ id: 1, name: 'A', value: 0, rate: 0.12, spread: null, weight: 1 }];
    close(monthlyFor({ groups: growing, years: 1, goal: 1000 }), 1000 * m / ((1 + m) ** 12 - 1));
    assert.equal(monthlyFor({ groups: [{ ...growing[0], value: 2000 }], years: 1, goal: 1000 }), 0, 'already there');
    assert.equal(monthlyFor({ groups: [{ ...flat[0], weight: 0 }], years: 1, goal: 1000 }), null, 'nowhere to put it');
    const safer = monthlyFor({ groups: [{ ...flat[0], rate: 0.07 }], years: 10, goal: 50_000, key: 'low' });
    assert.ok(safer > monthlyFor({ groups: [{ ...flat[0], rate: 0.07 }], years: 10, goal: 50_000 }), 'the lower estimate needs more');
});

test('the goal on the projection page', async () => {
    const app = await start({ data: await fixture() });
    app.clock.now = Date.parse('2026-06-30T12:00:00Z');
    try {
        const b = app.browser();
        await signUp(b, app.clock);
        // 632.96 now, nothing growing: (3,632.96 − 632.96) / 24 months = 125
        const html = await (await b.get('/projection?years=2&monthly=0&rate-1=0&rate-2=0&goal=3632.96&goalYear=2028')).text();
        assert.match(html, /To reach €3,633 by 2028/);
        assert.match(html, /<dt>Invest each month<\/dt><dd>€125<\/dd>/);
        const there = await (await b.get('/projection?years=2&monthly=0&rate-1=0&rate-2=0&goal=500&goalYear=2028')).text();
        assert.match(there, /You&#39;d get there without adding anything|You'd get there without adding anything/);
        const bad = await b.get('/projection?years=2&monthly=0&rate-1=0&rate-2=0&goal=lots&goalYear=1999');
        assert.equal(bad.status, 400);
        const text = await bad.text();
        assert.match(text, /Enter the amount you want to reach/);
        assert.match(text, /Enter a year from 2027 to 2076/);
        assert.doesNotMatch(await (await b.get('/projection')).text(), /To reach/, 'no goal, no goal section');
    } finally {
        app.close();
    }
});
