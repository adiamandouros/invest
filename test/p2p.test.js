import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { applyImport, parseStatement, planImport } from '../server/import/index.js';
import { csvRows } from '../server/import/mintos.js';
import { dec, fixed } from '../server/lib/decimal.js';
import { summariseP2p } from '../server/lib/p2p.js';
import { createRates, valuePortfolio } from '../server/lib/valuation.js';
import { csrfOf, location, signUp, start } from './helpers/app.js';
import { createMemoryData } from './helpers/memory-data.js';

// test/fixtures/mintos-statement.csv is made up. By hand, January to March 2025:
//   deposit 500, withdrawal 100 (1 March)
//   interest: Jan 2.25 + 0.0123456789… = 2.262346, Feb 1.75 + 0.5 = 2.25, Mar 1.2 + 0.01 = 1.21
//   tax: Jan −0.1125, Feb −0.0875, Mar −0.06; fee: Feb −0.05
//   loans: 300 + 150.5 + 20 bought − 25 − 100.5 repaid = 345; cash at the end 60.4123…
//   value = 500 − 100 + 5.722346 − 0.26 − 0.05 = 405.412346 = 345 + 60.412346
const CSV = readFileSync(new URL('./fixtures/mintos-statement.csv', import.meta.url), 'utf8');
const lines = CSV.trimEnd().split('\n');
// The statement up to the given date (the header and the rows before it)
const until = date => [lines[0], ...lines.slice(1).filter(l => l.slice(1, 11) <= date)].join('\n');
const from = date => [lines[0], ...lines.slice(1).filter(l => l.slice(1, 11) >= date)].join('\n');

const byRef = (list, ref) => list.find(t => t.ref === ref);

test('CSV fields can be quoted, with commas and quotes inside', () => {
    assert.deepEqual(csvRows('a,"b, c","say ""hi"""\r\n1,,3\n'), [['a', 'b, c', 'say "hi"'], ['1', '', '3']]);
});

test('a Mintos statement becomes deposits, withdrawals and monthly sums', () => {
    const s = parseStatement(CSV);
    assert.equal(s.platform, 'mintos');
    assert.equal(s.kind, 'p2p');
    assert.deepEqual(s.period, { start: '2025-01-01', end: '2025-03-31' });
    assert.deepEqual(s.warnings, []);
    assert.deepEqual(s.transactions.map(t => [t.ref, t.type, t.date, t.amount]), [
        ['mintos:00000000-000-00-0001aaaa-test', 'deposit', '2025-01-01', '500'],
        ['mintos:EUR:2025-01:tax', 'tax', '2025-01-15', '-0.1125'],
        ['mintos:EUR:2025-01:interest', 'interest', '2025-01-31', '2.262346'],
        ['mintos:EUR:2025-02:tax', 'tax', '2025-02-14', '-0.0875'],
        ['mintos:EUR:2025-02:interest', 'interest', '2025-02-20', '2.25'],
        ['mintos:EUR:2025-02:fee', 'fee', '2025-02-28', '-0.05'],
        ['mintos:00000000-000-00-0014aaaa-test', 'withdrawal', '2025-03-01', '-100'],
        ['mintos:EUR:2025-03:tax', 'tax', '2025-03-15', '-0.06'],
        ['mintos:EUR:2025-03:interest', 'interest', '2025-03-31', '1.21'],
    ]);
    assert.match(byRef(s.transactions, 'mintos:EUR:2025-02:interest').notes, /sum of 2 statement rows: Interest received, Interest received from loan repurchase/);
    assert.deepEqual(s.balances.map(b => [b.date, b.cash]), [['2025-01-31', '76.649846'], ['2025-02-28', '159.262346'], ['2025-03-31', '60.412346']]);
});

test('unknown payment types are reported, and the cash check still adds them up', async () => {
    const odd = `${CSV}"2025-03-31 23:30:00",x-1,"Something new",-5,55.4123456789012345,EUR,"Loan write-off adjustment"\n`;
    const s = parseStatement(odd);
    assert.match(s.warnings[0], /1 row of "Loan write-off adjustment" \(-5\.00 EUR in all\) not imported/);
    const plan = await planImport(s, createMemoryData());
    assert.equal(plan.check[0].ok, true, 'the statement\'s rows add up to its cash');
    assert.throws(() => parseStatement(`${lines[0]}\n"bad",1,x,1,1,EUR,Deposits\n`), /Row 2 of the statement can't be read/);
});

test('the import plan checks the cash and that the loans are not negative', async () => {
    const data = createMemoryData();
    const plan = await planImport(parseStatement(CSV), data);
    assert.equal(plan.account.id, null);
    assert.deepEqual(plan.accountFields, { name: 'Mintos', kind: 'p2p', platform: 'mintos', externalRef: null, baseCurrency: 'EUR', openedOn: '2025-01-01' });
    assert.equal(plan.transactions.length, 9);
    assert.deepEqual(plan.counts, { deposit: 1, tax: 3, interest: 3, fee: 1, withdrawal: 1 });
    assert.deepEqual(plan.check.map(c => [c.label, c.expected, c.computed, c.ok]), [
        ['Cash EUR on 2025-03-31', '60.41', '60.41', true],
        ['Money in loans (EUR, value minus cash)', 'not negative', '345.00', true],
    ]);

    // A later statement on its own: the app has no deposits yet, so the loans come out negative
    const alone = await planImport(parseStatement(from('2025-02-01')), createMemoryData());
    assert.equal(alone.checkOk, false);
});

test('importing again adds nothing; a month that was partly there is completed', async () => {
    const data = createMemoryData();
    await applyImport(await planImport(parseStatement(until('2025-02-14')), data), data);
    assert.equal(data.accounts[0].kind, 'p2p');
    const feb = () => data.transactions.find(t => t.importRef === 'mintos:EUR:2025-02:interest');
    assert.equal(feb().amount, '1.75', 'February so far');

    const again = await planImport(parseStatement(until('2025-02-14')), data);
    assert.equal(again.account.id, 1);
    assert.equal(again.transactions.length, 0);
    assert.equal(again.updates.length, 0);

    // The whole quarter: February is now complete, so its sums change
    const full = await planImport(parseStatement(CSV), data);
    assert.deepEqual(full.updates.map(u => [u.type, u.amount]), [['interest', '2.25']]);
    assert.equal(full.transactions.length, 4, 'February\'s fee, the withdrawal and March\'s two sums');
    await applyImport(full, data);
    assert.equal(feb().amount, '2.25');
    assert.equal(feb().date, '2025-02-20');
    assert.deepEqual(data.balances.map(x => x.date), ['2025-01-31', '2025-02-14', '2025-02-28', '2025-03-31'], 'the cash at the end of each statement month');

    // A statement starting mid-February doesn't replace February
    const partly = parseStatement(from('2025-02-15'));
    const plan = await planImport(partly, data);
    assert.equal(plan.updates.length, 0);
    assert.match(plan.warnings[0], /February 2025 is only partly in this statement/);
});

test('a P2P account\'s value, gain, return and income per month', async () => {
    const data = createMemoryData();
    await applyImport(await planImport(parseStatement(CSV), data), data);
    const account = data.accounts[0];
    const s = summariseP2p({ account, rows: data.transactions, balances: data.balances, today: '2025-12-31' });
    assert.deepEqual([s.value, s.contributed, s.gain, s.interest, s.tax, s.fees].map(v => fixed(v, 6)),
        ['405.412346', '400.000000', '5.412346', '5.722346', '-0.260000', '-0.050000']);
    assert.equal(s.valuedOn, null);
    assert.deepEqual(s.cash, { date: '2025-03-31', amount: dec('60.412346') });
    assert.deepEqual(s.months.map(m => [m.month, fixed(m.net, 4), fixed(m.cash, 2)]),
        [['2025-03', '1.1500', '60.41'], ['2025-02', '2.1125', '159.26'], ['2025-01', '2.1498', '76.65']]);
    assert.deepEqual(s.years.map(y => [y.year, fixed(y.net, 4)]), [['2025', '5.4123']]);
    assert.ok(s.xirr > 0.01 && s.xirr < 0.03, `about 1.6% a year, got ${s.xirr}`);

    // A value entered from Mintos counts from its day on: 5 lost to a write-off
    // (the ledger has 504.262346 on 28 February)
    const balances = [...data.balances, { accountId: 1, date: '2025-02-28', value: '499.2623', cash: null, source: 'manual', notes: null }];
    const after = summariseP2p({ account, rows: data.transactions, balances, today: '2025-12-31' });
    assert.equal(after.valuedOn, '2025-02-28');
    assert.equal(fixed(after.adjustment, 4), '-5.0000');
    assert.equal(fixed(after.value, 4), '400.4123', 'the entered value, then −100 + 1.21 − 0.06');

    // On the holdings page the account is worth that value
    const v = valuePortfolio({
        transactions: data.transactions.map(t => ({ ...t, account: t.accountId, instrument: null })),
        priceOf: () => null, eurPer: createRates([]), today: '2025-12-31',
        accountValues: new Map([['1|EUR', after.value]]),
    });
    assert.equal(fixed(v.cash[0].amount, 4), '400.4123');
    assert.equal(fixed(v.total.gainEur, 4), '0.4123');
});

function upload(csrf, text = CSV) {
    const form = new FormData();
    form.append('_csrf', csrf);
    form.append('statement', new Blob([text], { type: 'text/csv' }), 'statement.csv');
    return form;
}

test('the P2P pages: import a Mintos statement, see the account, add and delete a balance', async () => {
    const app = await start();
    app.clock.now = Date.parse('2025-12-31T12:00:00Z');
    try {
        const b = app.browser();
        assert.equal(location(await b.get('/p2p')), '/login');
        await signUp(b, app.clock);
        assert.match(await (await b.get('/p2p')).text(), /No P2P accounts yet/);

        const form = await (await b.get('/import')).text();
        const previewHtml = await (await b.post('/import/preview', upload(csrfOf(form)))).text();
        assert.match(previewHtml, /Mintos \(new\)/);
        assert.match(previewHtml, /Everything matches the statement/);
        const id = previewHtml.match(/name="id" value="([^"]+)"/)[1];
        const done = await (await b.post('/import/confirm', { _csrf: csrfOf(previewHtml), id })).text();
        assert.match(done, /Added 9 transactions to Mintos/);
        assert.match(done, /href="\/p2p"/);

        const list = await (await b.get('/p2p')).text();
        assert.match(list, /href="\/p2p\/1">Mintos/);
        assert.match(list, /€405\.41/);

        const page = await (await b.get('/p2p/1')).text();
        assert.match(page, /Income by year/);
        assert.match(page, /March 2025/);
        assert.match(page, /€60\.41/, 'cash not lent out');
        assert.equal((await b.get('/p2p/2')).status, 404);

        const holdings = await (await b.get('/holdings')).text();
        assert.match(holdings, /P2P lending/);
        assert.match(holdings, /href="\/p2p\/1">Mintos/);

        const accountRows = await (await b.get('/transactions?account=1')).text();
        assert.match(accountRows, /Transactions: Mintos/);

        const balanceForm = await (await b.get('/p2p/1/balances/new')).text();
        const bad = await b.post('/p2p/1/balances', { _csrf: csrfOf(balanceForm), date: '2025-13-01', value: 'lots' });
        assert.equal(bad.status, 400);
        assert.match(await bad.text(), /Enter a date/);
        const saved = await b.post('/p2p/1/balances', { _csrf: csrfOf(balanceForm), date: '2025-03-31', value: '400,41', cash: '', notes: 'From the overview' });
        assert.equal(location(saved), '/p2p/1');
        assert.deepEqual(app.data.balances.find(x => x.date === '2025-03-31'),
            { accountId: 1, date: '2025-03-31', value: '400.41', cash: '60.412346', source: 'manual', notes: 'From the overview' }, 'keeps the imported cash');
        assert.match(await (await b.get('/p2p/1')).text(), /from your balance on 2025-03-31 \(−€5\.00 against the statements\)/);

        assert.equal((await b.post('/p2p/1/balances/2025-03-31/delete', { _csrf: 'wrong' })).status, 403);
        await b.post('/p2p/1/balances/2025-03-31/delete', { _csrf: csrfOf(balanceForm) });
        assert.equal(app.data.balances.some(x => x.date === '2025-03-31'), false);
    } finally {
        app.close();
    }
});
