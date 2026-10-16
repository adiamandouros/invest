import { escapeHtml as esc } from '../pages.js';
import { KINDS, TYPES } from './forms.js';
import { TYPE_LABELS } from './views.js';

// The add/edit pages for transactions, instruments and accounts (also
// rendered by test/accessibility.test.js). `values` are the form's fields as
// text; `errors` maps a field name to a message.

const LABELS = {
    type: 'Type', date: 'Date', account: 'Account', instrument: 'Instrument', units: 'Units', price: 'Price per unit',
    amount: 'Amount', currency: 'Currency', fee: 'Fee', feeCurrency: 'Fee currency', fx: 'EUR rate', notes: 'Notes',
    symbol: 'Symbol', name: 'Name', isin: 'ISIN', kind: 'Kind', distributing: 'Dividends', assetClass: 'Asset class',
    platform: 'Platform', baseCurrency: 'Currency', openedOn: 'Opened on',
    priceSource: 'Prices', priceSymbol: 'Yahoo Finance symbol', value: 'Account value', cash: 'Cash not lent out',
};

export function summary(errors) {
    const entries = Object.entries(errors);
    if (!entries.length) return '';
    return `<div class="alert alert-danger" role="alert">
    <p class="mb-1">Check ${entries.length === 1 ? 'this field' : 'these fields'}:</p>
    <ul class="mb-0">${entries.map(([name, message]) => `<li><a href="#f-${name}">${LABELS[name] ?? name}: ${esc(message)}</a></li>`).join('')}</ul>
</div>`;
}

// One labelled form control with its hint and error. `options` makes it a
// select: [[value, label], ...].
export function field(name, { values, errors }, { type = 'text', hint = '', options = null, required = false, attrs = '' } = {}) {
    const id = `f-${name}`;
    const error = errors[name];
    const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');
    const common = `id="${id}" name="${name}"${required ? ' required' : ''}${described ? ` aria-describedby="${described}"` : ''}${error ? ' aria-invalid="true"' : ''} ${attrs}`.trimEnd();
    const value = values[name] ?? '';
    let control;
    if (options) {
        control = `<select class="form-select${error ? ' is-invalid' : ''}" ${common}>${options
            .map(([v, label]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    } else if (type === 'textarea') {
        control = `<textarea class="form-control${error ? ' is-invalid' : ''}" rows="2" ${common}>${esc(value)}</textarea>`;
    } else {
        control = `<input type="${type}" class="form-control${error ? ' is-invalid' : ''}" value="${esc(value)}" ${common}>`;
    }
    return `    <div class="mb-3">
        <label for="${id}" class="form-label">${LABELS[name]}</label>
        ${control}
        ${hint ? `<div id="${id}-hint" class="form-text">${hint}</div>` : ''}
        ${error ? `<div id="${id}-error" class="invalid-feedback d-block">${esc(error)}</div>` : ''}
    </div>`;
}

export const decimal = 'inputmode="decimal" autocomplete="off"';
const currency = 'maxlength="3" autocapitalize="characters" autocomplete="off"';

export function buttons({ cancel, extra = '' }) {
    return `    <div class="d-flex flex-wrap gap-2 mt-4">
        <button type="submit" class="btn btn-primary">Save</button>
        <a href="${cancel}" class="btn btn-outline-primary">Cancel</a>
        ${extra}
    </div>`;
}

// ── Transactions ────────────────────────────────────────────────────────────

export function transactionForm({ action, values, errors = {}, csrf, accounts, instruments, transaction = null }) {
    const f = { values, errors };
    const imported = transaction?.importRef
        ? '<p class="text-secondary-emphasis">Imported from a statement. Importing it again won\'t change this row or add it back.</p>' : '';
    return `<h1 class="fs-3">${transaction ? 'Edit transaction' : 'Add a transaction'}</h1>
${imported}
${summary(errors)}
<form method="post" action="${action}" class="edit-form" novalidate>
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
${field('type', f, { options: TYPES.map(t => [t, TYPE_LABELS[t]]), required: true })}
${field('date', f, { type: 'date', required: true })}
${field('account', f, { options: accounts.map(a => [a.id, a.name]), required: true })}
${field('instrument', f, {
        options: [['', 'None'], ...instruments.map(i => [i.id, `${i.symbol}: ${i.name}`])],
        hint: 'Needed for buys, sales, shares received or given, dividends and withheld tax.',
    })}
${field('units', f, { attrs: decimal, hint: 'For buys, sales, and shares received or given.' })}
${field('price', f, { attrs: decimal, hint: 'In the trade\'s currency. For shares received: what each one cost you.' })}
${field('amount', f, {
        attrs: decimal,
        hint: 'A positive number: the app knows from the type whether money came in or went out. For a buy or sale, leave it empty to use units × price. For a currency exchange: positive for the currency you got, negative for the one you paid.',
    })}
${field('currency', f, { attrs: currency, required: true, hint: 'The currency of the price and amount, like EUR or USD.' })}
${field('fee', f, { attrs: decimal, hint: 'What the broker charged, if anything.' })}
${field('feeCurrency', f, { attrs: currency, hint: 'Only if the fee was in another currency.' })}
${field('fx', f, { attrs: decimal, hint: 'For amounts not in EUR: how many EUR one unit was worth that day, e.g. 0.92 for USD. Leave it empty if you don\'t know.' })}
${field('notes', f, { type: 'textarea' })}
${buttons({
        cancel: '/transactions',
        extra: transaction ? `<a href="/transactions/${transaction.id}/delete" class="btn btn-outline-danger ms-auto">Delete…</a>` : '',
    })}
</form>`;
}

export const deleteTransactionContent = ({ transaction: t, csrf, description }) => `<h1 class="fs-3">Delete this transaction?</h1>
<p>${esc(description)}</p>
${t.importRef ? '<p>It came from an imported statement: importing that statement again would add it back.</p>' : ''}
<form method="post" action="/transactions/${t.id}/delete" class="d-flex flex-wrap gap-2 mt-4">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <button type="submit" class="btn btn-danger">Delete</button>
    <a href="/transactions/${t.id}/edit" class="btn btn-outline-primary">Cancel</a>
</form>`;

// ── Instruments ─────────────────────────────────────────────────────────────

const DIVIDENDS = [['', 'Not sure'], ['yes', 'Pays them out (distributing)'], ['no', 'Reinvests them (accumulating)']];
const KIND_LABELS = { etf: 'ETF', stock: 'Stock', other: 'Other' };

export function instrumentsContent({ instruments }) {
    const rows = instruments.map(i => `            <tr>
                <td><a href="/holdings/${i.id}">${esc(i.symbol)}</a></td>
                <td>${esc(i.name)}</td>
                <td class="text-nowrap">${esc(i.isin ?? '—')}</td>
                <td>${KIND_LABELS[i.kind]}</td>
                <td>${i.distributing === null || i.distributing === undefined ? 'Not sure' : i.distributing ? 'Distributing' : 'Accumulating'}</td>
                <td>${i.priceSource === 'none' ? 'None' : i.priceSymbol ? `Yahoo: ${esc(i.priceSymbol)}` : 'Yahoo (not set yet)'}</td>
                <td><a href="/instruments/${i.id}/edit">Edit<span class="visually-hidden"> ${esc(i.symbol)}</span></a></td>
            </tr>`).join('\n');
    return `<h1 class="fs-3">Instruments</h1>
<p><a href="/instruments/new" class="btn btn-outline-primary">Add an instrument</a></p>
${instruments.length ? `<div class="table-responsive">
    <table class="table table-sm align-middle">
        <caption class="visually-hidden">Instruments</caption>
        <thead><tr><th scope="col">Symbol</th><th scope="col">Name</th><th scope="col">ISIN</th><th scope="col">Kind</th><th scope="col">Dividends</th><th scope="col">Prices</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>
${rows}
        </tbody>
    </table>
</div>` : '<p>No instruments yet. They are added by imports, or here.</p>'}`;
}

export function instrumentForm({ action, values, errors = {}, csrf, editing = false }) {
    const f = { values, errors };
    return `<h1 class="fs-3">${editing ? 'Edit instrument' : 'Add an instrument'}</h1>
${summary(errors)}
<form method="post" action="${action}" class="edit-form" novalidate>
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
${field('symbol', f, { required: true, attrs: 'autocapitalize="characters" autocomplete="off"', hint: 'The ticker as your broker shows it, like VUAA.EU.' })}
${field('name', f, { required: true })}
${field('isin', f, { attrs: 'maxlength="12" autocapitalize="characters" autocomplete="off"', hint: '12 characters, like IE00BFMXXD54.' })}
${field('kind', f, { options: KINDS.map(k => [k, KIND_LABELS[k]]), required: true })}
${field('currency', f, { attrs: currency, required: true, hint: 'The currency it trades in at your broker.' })}
${field('distributing', f, { options: DIVIDENDS })}
${field('assetClass', f, { hint: 'Optional, for allocation targets later: like Equity or Bonds.' })}
${field('priceSource', f, { options: [['yahoo', 'Daily from Yahoo Finance'], ['none', 'None']] })}
${field('priceSymbol', f, {
        attrs: 'autocapitalize="characters" autocomplete="off"',
        hint: 'As in the address of its page on finance.yahoo.com, like VUAA.L (London, USD) or VUAA.DE (Xetra, EUR). Leave it empty and the app guesses it from the symbol.',
    })}
${buttons({ cancel: '/instruments' })}
</form>`;
}

export const instrumentFields = i => ({
    symbol: i.symbol, name: i.name, isin: i.isin ?? '', kind: i.kind, currency: i.currency,
    distributing: i.distributing === null || i.distributing === undefined ? '' : i.distributing ? 'yes' : 'no',
    assetClass: i.assetClass ?? '', priceSource: i.priceSource ?? 'yahoo', priceSymbol: i.priceSymbol ?? '',
});

// ── Accounts ────────────────────────────────────────────────────────────────

export function accountsContent({ accounts }) {
    const rows = accounts.map(a => `            <tr>
                <td>${esc(a.name)}</td>
                <td>${a.kind === 'p2p' ? 'P2P lending' : 'Broker'}</td>
                <td>${esc(a.platform)}</td>
                <td>${esc(a.baseCurrency)}</td>
                <td><a href="/accounts/${a.id}/edit">Edit<span class="visually-hidden"> ${esc(a.name)}</span></a></td>
            </tr>`).join('\n');
    return `<h1 class="fs-3">Accounts</h1>
<p><a href="/accounts/new" class="btn btn-outline-primary">Add an account</a></p>
${accounts.length ? `<div class="table-responsive">
    <table class="table table-sm align-middle">
        <caption class="visually-hidden">Accounts</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Platform</th><th scope="col">Currency</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>
${rows}
        </tbody>
    </table>
</div>` : '<p>No accounts yet. Importing a statement adds one, or add one here.</p>'}`;
}

export function accountForm({ action, values, errors = {}, csrf, editing = false }) {
    const f = { values, errors };
    return `<h1 class="fs-3">${editing ? 'Edit account' : 'Add an account'}</h1>
${summary(errors)}
<form method="post" action="${action}" class="edit-form" novalidate>
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
${field('name', f, { required: true, hint: 'How the app shows it, like Freedom24 or Mintos.' })}
${field('kind', f, { options: [['broker', 'Broker'], ['p2p', 'P2P lending']], required: true })}
${field('platform', f, { required: true, attrs: 'autocapitalize="none" autocomplete="off"', hint: 'Lower case, like freedom24, mintos or peerberry. Imports find their account by it.' })}
${field('baseCurrency', f, { attrs: currency, required: true })}
${field('openedOn', f, { type: 'date' })}
${field('notes', f, { type: 'textarea' })}
${buttons({ cancel: '/accounts' })}
</form>`;
}

export const accountFields = a => ({
    name: a.name, kind: a.kind, platform: a.platform, baseCurrency: a.baseCurrency, openedOn: a.openedOn ?? '', notes: a.notes ?? '',
});
