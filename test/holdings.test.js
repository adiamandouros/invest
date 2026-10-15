import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dec, div, fixed, mul, plain } from '../server/lib/decimal.js';
import { cash, positions } from '../server/lib/holdings.js';

test('decimals are exact and round half away from zero', () => {
    assert.equal(dec('0.1') + dec('0.2'), dec('0.3'));
    assert.equal(fixed(dec('1234.565001'), 2), '1234.57');
    assert.equal(fixed(dec('-0.005'), 2), '-0.01');
    assert.equal(fixed(dec('-0.004'), 2), '0.00', 'no "-0.00"');
    assert.equal(fixed(mul(dec('722.21'), dec('0.4')), 3), '288.884');
    assert.equal(fixed(div(dec('2'), dec('3')), 8), '0.66666667');
    assert.equal(plain(dec('12.000000')), '12');
    assert.equal(plain(dec(0.8913)), '0.8913');
    assert.equal(dec(null), null);
    assert.throws(() => dec('12abc'), /Not a number/);
});

const row = fields => ({ account: 1, instrument: 'X', currency: 'USD', fee: '0', feeCurrency: 'EUR', fxToEur: '0.9', ...fields });

test('a sale uses up the oldest shares first, fees counted in EUR', () => {
    const p = positions([
        row({ type: 'buy', date: '2024-01-01', units: '10', price: '10', amount: '-100', fee: '2' }),
        row({ type: 'buy', date: '2024-02-01', units: '10', price: '20', amount: '-200', fxToEur: '0.8' }),
        row({ type: 'sell', date: '2024-03-01', units: '15', price: '30', amount: '450', fee: '1', fxToEur: '1' }),
    ]).get('X');
    // Lot 1: 100 USD × 0.9 + 2 = 92 EUR. Lot 2: 200 × 0.8 = 160 EUR, half of it sold.
    assert.equal(plain(p.units), '5');
    assert.equal(fixed(p.cost), '100.00', 'half of lot 2, in USD');
    assert.equal(fixed(p.costEur), '80.00');
    assert.equal(fixed(p.realisedEur), '277.00', '450 − 1 − 92 − 80');
    assert.deepEqual(p.warnings, []);
});

test('rows are taken in date order, and overselling is reported', () => {
    const p = positions([
        row({ type: 'sell', date: '2024-03-01', units: '3', amount: '30', fxToEur: '1' }),
        row({ type: 'buy', date: '2024-01-01', units: '2', amount: '-10', fxToEur: '1' }),
    ]).get('X');
    assert.equal(plain(p.units), '-1');
    assert.match(p.warnings[0], /sold more units than were held/);
});

test('without an exchange rate, EUR figures are unknown, not wrong', () => {
    const p = positions([
        row({ type: 'buy', date: '2024-01-01', units: '1', amount: '-100', fxToEur: null }),
        row({ type: 'shares_in', date: '2024-01-02', units: '1', price: '0', amount: '0' }),
    ]).get('X');
    assert.equal(plain(p.units), '2');
    assert.equal(p.costEur, null);
    assert.equal(fixed(p.cost), '100.00');
});

test('dividends and withheld tax add up per currency', () => {
    const p = positions([
        row({ type: 'dividend', date: '2024-01-01', amount: '0.79' }),
        row({ type: 'tax', date: '2024-01-01', amount: '-0.24' }),
    ]).get('X');
    assert.equal(fixed(p.dividends.USD), '0.55');
    assert.equal(plain(p.units), '0');
});

test('cash adds up every amount and takes off every fee, per account and currency', () => {
    const balances = cash([
        { account: 1, type: 'deposit', amount: '1000', currency: 'EUR', fee: '0' },
        { account: 1, type: 'exchange', amount: '-900', currency: 'EUR', fee: '0' },
        { account: 1, type: 'exchange', amount: '1000', currency: 'USD', fee: '0' },
        { account: 1, type: 'buy', amount: '-800', currency: 'USD', fee: '2.21', feeCurrency: 'EUR' },
        { account: 2, type: 'deposit', amount: '5', currency: 'EUR' },
    ]);
    assert.deepEqual([...balances].map(([k, v]) => [k, fixed(v)]), [['1|EUR', '97.79'], ['1|USD', '200.00'], ['2|EUR', '5.00']]);
});
