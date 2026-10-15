import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { applyImport, parseStatement, planImport } from '../server/import/index.js';
import { fixed, plain } from '../server/lib/decimal.js';
import { positions } from '../server/lib/holdings.js';
import { parseMultipart } from '../server/multipart.js';
import { createMemoryData } from './helpers/memory-data.js';

// test/fixtures/freedom24-report.json is made up. By hand:
//   EUR: +1000 deposit − 900 for USD + 3.80 from USD − fees 2.21 + 1.97 + 1.97 + 2.18 = 95.47
//   USD: +1000 − 800 VUAA − 150 VTI + 440 VUAA + 1.50 OCGN − 4 + 2 CLSK + 0.79 − 0.24
//        − 50 + 60 − 100 withdrawn − 7.82 fee = 392.23
//   VUAA: 10 bought at 80 USD (rate 0.9, fee 2.21 EUR) = 722.21 EUR; 4 sold at 110 (fee 2.18 EUR)
//        → 6 left costing 433.326 EUR; gain 396 − 2.18 − 288.884 = 104.936 EUR
const REPORT = readFileSync(new URL('./fixtures/freedom24-report.json', import.meta.url), 'utf8');
const VUAA = 'IE00BFMXXD54';

test('a Freedom24 report becomes instruments and ledger rows', () => {
    const s = parseStatement(REPORT);
    assert.equal(s.platform, 'freedom24');
    assert.equal(s.accountRef, '100001');
    assert.deepEqual(s.period, { start: '2021-12-31', end: '2026-10-15' });
    assert.deepEqual(s.instruments.map(i => [i.key, i.symbol, i.kind, i.currency]), [
        [VUAA, 'VUAA.EU', 'etf', 'USD'],
        ['US67577C1053', 'OCGN.US', 'stock', 'USD'],
        ['US18452B2097', 'CLSK.US', 'stock', 'USD'],
        ['US9229087690', 'VTI.US', 'etf', 'USD'],
    ]);
    assert.equal(s.instruments[0].name, 'Vanguard S&P 500 UCITS ETF', 'names come from the positions');
    assert.deepEqual(s.warnings, []);

    const ref = r => s.transactions.find(t => t.ref === r);
    assert.deepEqual(
        [ref('trade:1:USD'), ref('trade:1:EUR')].map(t => [t.type, t.amount, t.currency, t.fxToEur]),
        [['exchange', '1000', 'USD', '0.9'], ['exchange', '-900', 'EUR', '1']]);
    const buy = ref('trade:2');
    assert.deepEqual([buy.type, buy.units, buy.price, buy.amount, buy.fee, buy.feeCurrency, buy.fxToEur],
        ['buy', '10', '80', '-800', '2.21', 'EUR', '0.9000'], 'the rate comes from the trade\'s comment');
    assert.equal(ref('cash:103').type, 'tax');
    assert.equal(ref('cash:103').instrumentKey, 'US9229087690');
    assert.equal(ref('cash:112').type, 'withdrawal');
    assert.equal(s.transactions.some(t => /^cash:(106|108|109|110|111|113)$/.test(t.ref)), false, 'withdrawal bookkeeping is left out');
    assert.deepEqual([ref('fee:2024-10-03 17:30:05:7.82USD').type, ref('fee:2024-10-03 17:30:05:7.82USD').amount], ['fee', '-7.82']);
    assert.equal(ref('securities:7001').type, 'shares_in');
    assert.deepEqual(s.opening.positions, { US67577C1053: { units: '1', price: '0' } });
});

test('the import plan matches the report\'s closing balances', async () => {
    const data = createMemoryData();
    const plan = await planImport(parseStatement(REPORT), data);
    assert.equal(plan.account.id, null, 'a new account');
    assert.equal(plan.newInstruments.length, 4);
    assert.equal(plan.transactions.length, 18, '17 rows + OCGN held at the start');
    assert.equal(plan.counts.shares_in, 2);
    assert.equal(plan.duplicates, 0);
    assert.deepEqual(plan.check.map(c => [c.label, c.expected, c.computed, c.ok]), [
        ['Cash EUR', '95.47', '95.47', true],
        ['Cash USD', '392.23', '392.23', true],
        ['VTI.US', '1', '1', true],
        ['VUAA.EU', '6', '6', true],
    ]);
    assert.equal(plan.checkOk, true);
});

test('after the import, holdings have FIFO costs in EUR', async () => {
    const data = createMemoryData();
    await applyImport(await planImport(parseStatement(REPORT), data), data);
    const ids = new Map(data.instruments.map(i => [i.isin, i.id]));
    const held = positions(data.transactions.map(t => ({ ...t, account: t.accountId, instrument: t.instrumentId })));

    const vuaa = held.get(ids.get(VUAA));
    assert.deepEqual([plain(vuaa.units), fixed(vuaa.cost), fixed(vuaa.costEur, 3), fixed(vuaa.realisedEur, 3)],
        ['6', '480.00', '433.326', '104.936']);
    const vti = held.get(ids.get('US9229087690'));
    assert.deepEqual([plain(vti.units), fixed(vti.costEur), fixed(vti.dividends.USD)], ['1', '141.00', '0.55']);
    // OCGN cost nothing (held at the start at 0) and sold for 1.50 USD × 0.9755 − 1.97 EUR fee
    assert.equal(fixed(held.get(ids.get('US67577C1053')).realisedEur), '-0.51');
});

test('importing again adds nothing, and a later report starts from what is already there', async () => {
    const data = createMemoryData();
    await applyImport(await planImport(parseStatement(REPORT), data), data);

    const again = await planImport(parseStatement(REPORT), data);
    assert.equal(again.account.id, 1);
    assert.equal(again.transactions.length, 0);
    assert.equal(again.duplicates, 17);
    assert.equal(again.checkOk, true);

    // A report for the following period starts with the positions the app already has
    const later = parseStatement(REPORT);
    later.period = { start: '2026-10-15', end: '2026-12-31' };
    later.transactions = [];
    later.opening = { cash: { EUR: '95.47', USD: '392.23' }, positions: { [VUAA]: { units: '6', price: '80' }, US9229087690: { units: '1', price: '150' } } };
    const next = await planImport(later, data);
    assert.equal(next.transactions.length, 0, 'no opening rows for what is already held');
    assert.equal(next.checkOk, true);
});

test('unknown rows are reported, and wrong files are refused', () => {
    const report = JSON.parse(REPORT);
    report.cash_in_outs.push({ id: 999, currency: 'USD', type: 'mystery', datetime: '2025-01-01', amount: '1', offbalance: null });
    assert.match(parseStatement(JSON.stringify(report)).warnings[0], /Cash row 999: unknown type "mystery"/);
    assert.throws(() => parseStatement('not json'), /isn't a statement the app can read/);
    assert.throws(() => parseStatement('{"hello": 1}'), /Freedom24 broker report \(JSON\) or a Mintos account statement \(CSV\)/);
});

test('multipart forms are read into fields and files', () => {
    const body = Buffer.from([
        '--XyZ', 'Content-Disposition: form-data; name="_csrf"', '', 'token',
        '--XyZ', 'Content-Disposition: form-data; name="statement"; filename="r.json"', 'Content-Type: application/json', '', '{"a":1}\r\n{"b":2}',
        '--XyZ--', '',
    ].join('\r\n'));
    const { fields, files } = parseMultipart(body, 'multipart/form-data; boundary=XyZ');
    assert.deepEqual(fields, { _csrf: 'token' });
    assert.equal(files.statement.filename, 'r.json');
    assert.equal(files.statement.data.toString(), '{"a":1}\r\n{"b":2}');
    assert.throws(() => parseMultipart(body, 'text/plain'), /Not a multipart form/);
});
