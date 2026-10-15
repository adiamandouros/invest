import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plain } from '../server/lib/decimal.js';
import { number, parseAccount, parseInstrument, parseTransaction, transactionFields } from '../server/portfolio/forms.js';

const choices = { accounts: [{ id: 1 }], instruments: [{ id: 7 }] };
const form = fields => ({ type: 'buy', date: '2026-10-15', account: '1', instrument: '7', currency: 'usd', ...fields });

test('numbers may use a comma or a point, with or without thousands', () => {
    assert.equal(plain(number('12,5')), '12.5');
    assert.equal(plain(number('1,234.56')), '1234.56');
    assert.equal(plain(number(' 1 234.56 ')), '1234.56');
    assert.equal(number(''), null);
    assert.throws(() => number('12x'));
});

test('a buy: amount is units × price and negative; the rate is optional', () => {
    const { values, errors } = parseTransaction(form({ units: '3', price: '76,34', fee: '0' }), choices);
    assert.deepEqual(errors, {});
    assert.deepEqual(values, {
        accountId: 1, instrumentId: 7, type: 'buy', date: '2026-10-15', units: '3', price: '76.34', amount: '-229.02',
        currency: 'USD', fee: '0', feeCurrency: null, fxToEur: null, notes: null,
    });
});

test('signs follow the type, and an EUR amount has a rate of 1', () => {
    const value = fields => parseTransaction(form({ instrument: '', currency: 'EUR', ...fields }), choices).values;
    assert.equal(value({ type: 'withdrawal', amount: '100' }).amount, '-100');
    assert.equal(value({ type: 'deposit', amount: '100' }).amount, '100');
    assert.equal(value({ type: 'fee', amount: '-2', fee: '' }).amount, '-2', 'a fee is money out, however it was typed');
    assert.equal(value({ type: 'exchange', amount: '-945' }).amount, '-945', 'an exchange keeps its sign');
    assert.equal(value({ type: 'deposit', amount: '5' }).fxToEur, '1');
    const shares = parseTransaction(form({ type: 'shares_in', units: '1', price: '0', amount: '50' }), choices).values;
    assert.equal(shares.amount, '0', 'shares received move no cash');
});

test('missing and wrong fields are named', () => {
    const { errors } = parseTransaction({ type: 'sell', date: '2026-02-30', account: '9', instrument: '', units: '-1', currency: 'dollars', fee: 'x' }, choices);
    assert.deepEqual(Object.keys(errors).sort(), ['account', 'currency', 'date', 'fee', 'instrument', 'price', 'units']);
    assert.match(errors.date, /Enter a date/);
    assert.match(errors.units, /positive/);
    assert.deepEqual(Object.keys(parseTransaction(form({ type: 'deposit', instrument: '', amount: '0' }), choices).errors), ['amount']);
});

test('an existing transaction fills the form with positive amounts', () => {
    const fields = transactionFields({
        accountId: 1, instrumentId: 7, type: 'tax', date: '2023-03-31', units: null, price: null, amount: '-0.240000',
        currency: 'USD', fee: '0.000000', feeCurrency: null, fxToEur: null, notes: null,
    });
    assert.deepEqual([fields.amount, fields.instrument, fields.fee, fields.units], ['0.24', '7', '', '']);
});

test('instruments and accounts are checked', () => {
    const ok = parseInstrument({ symbol: 'vwce.de', name: 'Vanguard FTSE All-World', isin: 'ie00bk5bqt80', kind: 'etf', currency: 'eur', distributing: 'no' });
    assert.deepEqual(ok.errors, {});
    assert.deepEqual(ok.values, { symbol: 'VWCE.DE', name: 'Vanguard FTSE All-World', isin: 'IE00BK5BQT80', kind: 'etf', currency: 'EUR', distributing: false, assetClass: null });
    assert.equal(parseInstrument({ ...ok.values, distributing: '' }).values.distributing, null);
    assert.deepEqual(Object.keys(parseInstrument({ symbol: '', name: '', isin: 'X1', kind: 'bond', currency: '' }).errors).sort(), ['currency', 'isin', 'kind', 'name', 'symbol']);

    const account = parseAccount({ name: 'Mintos', kind: 'p2p', platform: 'Mintos', baseCurrency: 'eur', openedOn: '' });
    assert.deepEqual(account.errors, {});
    assert.deepEqual(account.values, { name: 'Mintos', kind: 'p2p', platform: 'mintos', baseCurrency: 'EUR', openedOn: null, notes: null });
    assert.deepEqual(Object.keys(parseAccount({ name: '', kind: 'bank', platform: '', baseCurrency: 'e', openedOn: 'soon' }).errors).sort(),
        ['baseCurrency', 'kind', 'name', 'openedOn', 'platform']);
});
