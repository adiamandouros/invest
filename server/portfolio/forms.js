import { abs, dec, mul, plain } from '../lib/decimal.js';

// Checking the add/edit forms for transactions, instruments and accounts.
// Each parse function takes the submitted fields and returns
// { values, errors }, where errors maps a field name to a message; values are
// ready for server/data/store.js when there are no errors.

export const TYPES = ['buy', 'sell', 'dividend', 'tax', 'fee', 'interest', 'deposit', 'withdrawal',
    'transfer_in', 'transfer_out', 'exchange', 'shares_in', 'shares_out'];
const NEEDS_INSTRUMENT = new Set(['buy', 'sell', 'shares_in', 'shares_out', 'dividend', 'tax']);
const NEEDS_UNITS = new Set(['buy', 'sell', 'shares_in', 'shares_out']);
// The sign of `amount` follows from the type; the form always asks for a positive number
const PAYS = new Set(['buy', 'withdrawal', 'transfer_out', 'tax', 'fee']);
const NO_CASH = new Set(['shares_in', 'shares_out']);

const text = value => String(value ?? '').trim();
const CURRENCY = /^[A-Z]{3}$/;

// "1,234.56", "1234,56" and "1 234.56" all mean 1234.56. Returns a decimal or
// null if blank; throws if it isn't a number.
export function number(value) {
    let t = text(value).replace(/[\s ]/g, '');
    if (!t) return null;
    if (t.includes(',') && t.includes('.')) t = t.replace(/,/g, '');
    else t = t.replace(',', '.');
    return dec(t);
}

function isDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

// `accounts`, `instruments`: what the form's choices may refer to
export function parseTransaction(body, { accounts, instruments }) {
    const errors = {};
    const read = (name, { required = false, positive = false, signed = false } = {}) => {
        try {
            const value = number(body[name]);
            if (value === null) {
                if (required) errors[name] = 'Enter a number.';
                return null;
            }
            if (!signed && value < 0n) errors[name] = 'Enter a positive number.';
            else if ((positive || signed) && value === 0n) errors[name] = 'Enter a number other than zero.';
            return value;
        } catch {
            errors[name] = 'Enter a number, like 12.5';
            return null;
        }
    };

    const type = text(body.type);
    if (!TYPES.includes(type)) errors.type = 'Choose a type.';
    const accountId = Number(body.account);
    if (!accounts.some(a => a.id === accountId)) errors.account = 'Choose an account.';
    const date = text(body.date);
    if (!isDate(date)) errors.date = 'Enter a date, like 2026-10-15.';

    const instrumentId = body.instrument ? Number(body.instrument) : null;
    if (instrumentId !== null && !instruments.some(i => i.id === instrumentId)) errors.instrument = 'Choose an instrument from the list.';
    else if (instrumentId === null && NEEDS_INSTRUMENT.has(type)) errors.instrument = 'Choose the instrument.';

    const units = read('units', { required: NEEDS_UNITS.has(type), positive: true });
    const price = read('price', { required: type === 'buy' || type === 'sell' });
    let amount = read('amount', { required: !NEEDS_UNITS.has(type), positive: !NEEDS_UNITS.has(type) && type !== 'exchange', signed: type === 'exchange' });
    const fee = read('fee') ?? 0n;
    const fxToEur = read('fx', { positive: true });

    const currency = text(body.currency).toUpperCase();
    if (!CURRENCY.test(currency)) errors.currency = 'Enter a 3-letter currency code, like EUR or USD.';
    const feeCurrency = text(body.feeCurrency).toUpperCase() || currency;
    if (fee !== 0n && !CURRENCY.test(feeCurrency)) errors.feeCurrency = 'Enter a 3-letter currency code.';

    // A buy or sale's amount is units × price unless given
    if (amount === null && (type === 'buy' || type === 'sell') && units !== null && price !== null) amount = mul(units, price);
    if (NO_CASH.has(type)) amount = 0n;
    if (amount !== null && type !== 'exchange') amount = PAYS.has(type) ? -abs(amount) : abs(amount);

    const notes = text(body.notes).slice(0, 500) || null;
    const asText = v => (v === null ? null : plain(v));
    return {
        errors,
        values: {
            accountId, instrumentId: NEEDS_INSTRUMENT.has(type) || instrumentId ? instrumentId : null, type, date,
            units: NEEDS_UNITS.has(type) ? asText(units) : null,
            price: asText(price),
            amount: asText(amount),
            currency,
            fee: plain(fee),
            feeCurrency: fee === 0n ? null : feeCurrency,
            fxToEur: currency === 'EUR' ? '1' : asText(fxToEur),
            notes,
        },
    };
}

// The form's fields for an existing transaction (amounts shown positive, except exchanges)
export function transactionFields(t) {
    const show = v => (v === null || v === undefined ? '' : plain(dec(v)));
    return {
        account: String(t.accountId), type: t.type, date: t.date, instrument: t.instrumentId ? String(t.instrumentId) : '',
        units: show(t.units), price: show(t.price),
        amount: t.type === 'exchange' ? show(t.amount) : (NO_CASH.has(t.type) ? '' : show(t.amount === null ? null : abs(dec(t.amount)))),
        currency: t.currency, fee: dec(t.fee) ? show(t.fee) : '', feeCurrency: t.feeCurrency ?? '',
        fx: t.currency === 'EUR' ? '' : show(t.fxToEur), notes: t.notes ?? '',
    };
}

export const KINDS = ['etf', 'stock', 'other'];

export function parseInstrument(body) {
    const errors = {};
    const symbol = text(body.symbol).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.\-]{0,31}$/.test(symbol)) errors.symbol = 'Enter the ticker, like VUAA.EU (letters, digits, dots, dashes).';
    const name = text(body.name);
    if (!name) errors.name = 'Enter a name.';
    else if (name.length > 200) errors.name = 'Use at most 200 characters.';
    const isin = text(body.isin).toUpperCase() || null;
    if (isin && !/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) errors.isin = 'An ISIN is 12 characters, like IE00BFMXXD54. Or leave it empty.';
    const kind = text(body.kind);
    if (!KINDS.includes(kind)) errors.kind = 'Choose a kind.';
    const currency = text(body.currency).toUpperCase();
    if (!CURRENCY.test(currency)) errors.currency = 'Enter a 3-letter currency code, like EUR or USD.';
    const distributing = { yes: true, no: false }[text(body.distributing)] ?? null;
    const assetClass = text(body.assetClass).slice(0, 50) || null;
    const priceSource = text(body.priceSource) || 'yahoo';
    if (!['yahoo', 'none'].includes(priceSource)) errors.priceSource = 'Choose where prices come from.';
    // Empty: the app suggests one from the symbol when it first needs a price
    const priceSymbol = text(body.priceSymbol).toUpperCase() || null;
    if (priceSymbol && !/^[A-Z0-9^][A-Z0-9.^=\-]{0,31}$/.test(priceSymbol)) errors.priceSymbol = 'Enter the symbol as Yahoo Finance shows it, like VUAA.L.';
    return { errors, values: { symbol, name, isin, kind, currency, distributing, assetClass, priceSymbol, priceSource } };
}

export function parseAccount(body) {
    const errors = {};
    const name = text(body.name);
    if (!name) errors.name = 'Enter a name.';
    else if (name.length > 100) errors.name = 'Use at most 100 characters.';
    const kind = text(body.kind);
    if (!['broker', 'p2p'].includes(kind)) errors.kind = 'Choose a kind.';
    const platform = text(body.platform).toLowerCase();
    if (!/^[a-z0-9][a-z0-9 ._-]{0,49}$/.test(platform)) errors.platform = 'Enter the platform, like freedom24 or mintos.';
    const baseCurrency = text(body.baseCurrency).toUpperCase();
    if (!CURRENCY.test(baseCurrency)) errors.baseCurrency = 'Enter a 3-letter currency code, like EUR.';
    const openedOn = text(body.openedOn) || null;
    if (openedOn && !isDate(openedOn)) errors.openedOn = 'Enter a date, like 2022-01-24. Or leave it empty.';
    const notes = text(body.notes).slice(0, 500) || null;
    return { errors, values: { name, kind, platform, baseCurrency, openedOn, notes } };
}
