import { dec, div, fixed, plain } from '../lib/decimal.js';
import { escapeHtml as esc } from '../pages.js';

// The holdings, transactions and import pages, as HTML for createRenderer's
// `content` (also rendered by test/accessibility.test.js)

export const TYPE_LABELS = {
    buy: 'Buy', sell: 'Sell', shares_in: 'Shares received', shares_out: 'Shares given',
    dividend: 'Dividend', tax: 'Tax withheld', fee: 'Fee', interest: 'Interest',
    deposit: 'Deposit', withdrawal: 'Withdrawal', transfer_in: 'Transfer in', transfer_out: 'Transfer out',
    exchange: 'Currency exchange',
};

const formatters = new Map();
function formatter(currency, signed) {
    const key = `${currency}|${signed}`;
    if (!formatters.has(key)) {
        formatters.set(key, new Intl.NumberFormat('en-IE', {
            style: 'currency', currency, signDisplay: signed ? 'exceptZero' : 'auto',
        }));
    }
    return formatters.get(key);
}

// "€1,234.56"; null → "unknown". `signed` adds + to gains (losses always get −).
export function money(value, currency, { signed = false } = {}) {
    if (value === null || value === undefined) return '<span class="text-secondary-emphasis">unknown</span>';
    return esc(formatter(currency, signed).format(Number(fixed(value, 2))).replace('-', '−'));
}

const units = value => esc(plain(value));
const table = (id, heading, head, body) => `
<h2 class="fs-5 mt-4" id="${id}">${heading}</h2>
<div class="table-responsive">
    <table class="table table-sm align-middle" aria-labelledby="${id}">
        <thead><tr>${head}</tr></thead>
        <tbody>
${body}
        </tbody>
    </table>
</div>`;
const th = (label, numeric = false) => `<th scope="col"${numeric ? ' class="text-end"' : ''}>${label}</th>`;
const td = (html, numeric = false) => `<td${numeric ? ' class="text-end text-nowrap"' : ''}>${html}</td>`;
const dividends = map => Object.entries(map).map(([c, v]) => money(v, c, { signed: true })).join('<br>') || '—';
const instrumentCell = i => `<a href="/transactions?instrument=${i.id}">${esc(i.symbol)}</a><br><span class="small text-secondary-emphasis">${esc(i.name)}</span>`;

const NOTHING_YET = `<p>Nothing recorded yet. <a href="/import">Import a broker statement</a> to start.</p>`;

// "+7.3% a year"; null → "—"
export function percent(rate) {
    if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
    const text = (rate * 100).toFixed(1);
    return Number(text) === 0 ? '0.0%' : `${rate > 0 ? '+' : '−'}${text.replace('-', '')}%`;
}

const small = text => `<br><span class="small text-secondary-emphasis">${text}</span>`;

// `valuation`: server/lib/valuation.js valuePortfolio(); `instruments`,
// `accounts`: Maps by id; `status`: market_updates rows; `updating`: an update is running
export function holdingsContent({ valuation: v, instruments, accounts, status = {}, updating = false, csrf }) {
    if (!v.positions.length && !v.cash.length) return `<h1 class="fs-3">Holdings</h1>\n${NOTHING_YET}`;
    const instrument = id => instruments.get(id);
    const open = v.positions.filter(p => p.open).sort((a, b) => instrument(a.instrument).symbol.localeCompare(instrument(b.instrument).symbol));
    const closed = v.positions.filter(p => !p.open).sort((a, b) => instrument(a.instrument).symbol.localeCompare(instrument(b.instrument).symbol));
    const t = v.total;

    const notices = [];
    if (updating) notices.push('<div class="alert alert-info" role="status">Updating prices and exchange rates. Reload the page in a minute to see them.</div>');
    const failed = Object.values(status).filter(s => !s.ok && s.message);
    if (failed.length) notices.push(`<div class="alert alert-warning" role="alert">The last update had problems: ${failed.map(s => esc(s.message)).join('; ')}</div>`);
    if (v.missingPrices.length) {
        notices.push(`<div class="alert alert-warning" role="alert">No price yet for ${v.missingPrices.map(id => `<a href="/instruments/${id}/edit">${esc(instrument(id).symbol)}</a>`).join(', ')}, so the totals can't be worked out. Check its price symbol.</div>`);
    }
    const ageDays = v.pricesAsOf ? (Date.now() - Date.parse(`${v.pricesAsOf}T00:00:00Z`)) / 86_400_000 : 0;
    if (ageDays > 5) notices.push(`<div class="alert alert-warning" role="alert">The newest prices are from ${esc(v.pricesAsOf)}, ${Math.floor(ageDays)} days ago.</div>`);

    const summary = `<dl class="summary">
    <div><dt>Value now</dt><dd>${money(t.valueEur, 'EUR')}</dd></div>
    <div><dt>Put in</dt><dd>${money(t.investedEur, 'EUR')}</dd></div>
    <div><dt>Gain</dt><dd>${money(t.gainEur, 'EUR', { signed: true })}</dd></div>
    <div><dt>Return a year</dt><dd>${percent(t.xirr)}</dd></div>
</dl>`;

    const openRows = open.map(p => {
        const i = instrument(p.instrument);
        return `            <tr>
                ${td(instrumentCell(i))}
                ${td(units(p.units), true)}
                ${td(p.price ? money(p.price.close, p.price.currency) + small(esc(p.price.date)) : '—', true)}
                ${td(money(p.valueEur, 'EUR'), true)}
                ${td(money(p.costEur, 'EUR') + (p.units > 0n ? small(`avg ${money(div(p.cost, p.units), p.currency)}`) : ''), true)}
                ${td(money(p.unrealisedEur, 'EUR', { signed: true }), true)}
                ${td(percent(p.xirr), true)}
                ${td(money(p.realisedEur, 'EUR', { signed: true }), true)}
                ${td(p.dividendsEur ? money(p.dividendsEur, 'EUR', { signed: true }) : '—', true)}
            </tr>`;
    }).join('\n');
    const totalRow = `            <tr>
                <th scope="row">Total</th>${td('')}${td('')}
                ${td(`<strong>${money(t.valueEur === null ? null : open.reduce((sum, p) => (sum === null || p.valueEur === null ? null : sum + p.valueEur), 0n), 'EUR')}</strong>`, true)}
                ${td(`<strong>${money(t.costEur, 'EUR')}</strong>`, true)}
                ${td(`<strong>${money(t.unrealisedEur, 'EUR', { signed: true })}</strong>`, true)}
                ${td('')}${td('')}${td('')}
            </tr>`;
    const closedRows = closed.map(p => `            <tr>
                ${td(instrumentCell(instrument(p.instrument)))}
                ${td(money(p.realisedEur, 'EUR', { signed: true }), true)}
                ${td(p.dividendsEur ? money(p.dividendsEur, 'EUR', { signed: true }) : '—', true)}
            </tr>`).join('\n');
    const cashRows = v.cash.map(b => `            <tr>
                ${td(esc(accounts.get(Number(b.account))?.name ?? ''))}
                ${td(money(b.amount, b.currency), true)}
                ${td(money(b.valueEur, 'EUR'), true)}
            </tr>`).join('\n');

    return `<h1 class="fs-3">Holdings</h1>
${notices.join('\n')}
${summary}
<form method="post" action="/prices/update" class="prices-line">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <span>${v.pricesAsOf ? `Prices as of ${esc(v.pricesAsOf)} from Yahoo Finance, exchange rates from the ECB.` : 'No prices yet.'}</span>
    <button type="submit" class="btn btn-outline-primary btn-sm">Update now</button>
</form>
${open.length ? table('open-heading', 'Positions',
        th('Instrument') + th('Units', true) + th('Price', true) + th('Value (EUR)', true) + th('Cost (EUR)', true)
        + th('Unrealised gain', true) + th('Return a year', true) + th('Realised gain', true) + th('Dividends after tax (EUR)', true),
        `${openRows}\n${totalRow}`) : ''}
${closed.length ? table('closed-heading', 'Closed positions', th('Instrument') + th('Realised gain (EUR)', true) + th('Dividends after tax (EUR)', true), closedRows) : ''}
${v.cash.length ? table('cash-heading', 'Cash', th('Account') + th('Balance', true) + th('Value (EUR)', true), cashRows) : ''}
<p class="small text-secondary-emphasis mt-4">Cost is what you paid, fees included, in EUR at the rate on the day; sales use up the oldest shares first (FIFO). Value uses the latest close and today's ECB rate. "Put in" is deposits minus withdrawals, in EUR on the day. Return a year is the money-weighted return (XIRR), which accounts for when money went in and out.</p>`;
}

// `rows`: transactions with .account and .instrument attached
export function transactionsContent({ rows, instrument }) {
    const heading = instrument ? `Transactions: ${esc(instrument.symbol)}` : 'Transactions';
    const add = `<p><a href="/transactions/new${instrument ? `?instrument=${instrument.id}` : ''}" class="btn btn-outline-primary">Add a transaction</a></p>`;
    if (!rows.length) return `<h1 class="fs-3">${heading}</h1>\n${add}\n${NOTHING_YET}`;
    const body = [...rows].reverse().map(t => `            <tr>
                ${td(`<span class="text-nowrap">${esc(t.date)}</span>`)}
                ${td(esc(TYPE_LABELS[t.type] ?? t.type))}
                ${td(t.instrument ? `<a href="/transactions?instrument=${t.instrument.id}">${esc(t.instrument.symbol)}</a>` : '—')}
                ${td(t.units === null ? '—' : units(dec(t.units)), true)}
                ${td(!dec(t.price) ? '—' : units(dec(t.price)), true)}
                ${td(money(dec(t.amount), t.currency, { signed: true }), true)}
                ${td(dec(t.fee) ? money(dec(t.fee), t.feeCurrency ?? t.currency) : '—', true)}
                ${td(esc(t.account.name))}
                ${td(`<a href="/transactions/${t.id}/edit">Edit<span class="visually-hidden"> ${esc(t.date)} ${esc(TYPE_LABELS[t.type] ?? t.type)}</span></a>`)}
            </tr>`).join('\n');
    return `<h1 class="fs-3">${heading}</h1>
${instrument ? `<p>${esc(instrument.name)}${instrument.isin ? ` · ${esc(instrument.isin)}` : ''} · <a href="/instruments/${instrument.id}/edit">Edit instrument</a> · <a href="/transactions">All transactions</a></p>` : ''}
${add}
${table('transactions-heading', `${rows.length} transaction${rows.length === 1 ? '' : 's'}, newest first`, th('Date') + th('Type') + th('Instrument') + th('Units', true) + th('Price', true) + th('Amount', true) + th('Fee', true) + th('Account') + '<th scope="col"><span class="visually-hidden">Actions</span></th>', body)}`;
}

export const importContent = ({ csrf, error = '' }) => `<h1 class="fs-3">Import a statement</h1>
<p>Upload a <strong>Freedom24 broker report</strong> in JSON format (in Freedom24: Reports → Broker report, choose the whole period and JSON). Next you'll see what it adds and whether the result matches the report's closing balances, before anything is saved.</p>
<p class="text-secondary-emphasis">Importing the same or an overlapping report again only adds what's new.</p>
${error ? `<div class="alert alert-danger" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="/import/preview" enctype="multipart/form-data" class="mt-4">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="mb-4">
        <label for="statement" class="form-label">Report file (.json)</label>
        <input id="statement" name="statement" type="file" class="form-control" accept=".json,application/json" required>
    </div>
    <button type="submit" class="btn btn-primary">Preview the import</button>
</form>`;

export function previewContent({ plan, csrf, id }) {
    const total = plan.transactions.length;
    const counts = Object.entries(plan.counts).map(([type, n]) => `<li>${n} × ${esc(TYPE_LABELS[type] ?? type)}</li>`).join('');
    const checkRows = plan.check.map(c => `            <tr>
                ${td(esc(c.label))}
                ${td(esc(c.expected), true)}
                ${td(esc(c.computed), true)}
                ${td(c.ok ? '<i class="bi bi-check-circle me-1" aria-hidden="true"></i>Matches' : '<strong><i class="bi bi-x-circle me-1" aria-hidden="true"></i>Differs</strong>')}
            </tr>`).join('\n');
    return `<h1 class="fs-3">Check the import</h1>
<dl class="row">
    <dt class="col-sm-4">Account</dt>
    <dd class="col-sm-8">${esc(plan.account.name)}${plan.account.id ? '' : ' (new)'}</dd>
    <dt class="col-sm-4">Period</dt>
    <dd class="col-sm-8">${esc(plan.period.start)} to ${esc(plan.period.end)}</dd>
    <dt class="col-sm-4">New instruments</dt>
    <dd class="col-sm-8">${plan.newInstruments.map(i => `${esc(i.symbol)} (${esc(i.name)})`).join(', ') || 'None'}</dd>
    <dt class="col-sm-4">New transactions</dt>
    <dd class="col-sm-8">${total ? `${total}<ul class="mb-0">${counts}</ul>` : 'None'}</dd>
    <dt class="col-sm-4">Already imported</dt>
    <dd class="col-sm-8">${plan.duplicates}</dd>
</dl>
${plan.warnings.length ? `<div class="alert alert-warning" role="alert"><p class="mb-1">Some rows need a look:</p><ul class="mb-0">${plan.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
${table('check-heading', 'Compared with the report\'s closing balances', th('Item') + th('Report', true) + th('App after import', true) + th('Result'), checkRows)}
<p>${plan.checkOk ? 'Everything matches the report.' : '<strong>Some figures differ from the report.</strong> You can still import, but check the transactions afterwards.'}</p>
${total ? `<form method="post" action="/import/confirm" class="d-flex flex-wrap gap-2 mt-4">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <input type="hidden" name="id" value="${esc(id)}">
    <button type="submit" class="btn btn-primary">Import ${total} transaction${total === 1 ? '' : 's'}</button>
    <a href="/import" class="btn btn-outline-primary">Cancel</a>
</form>` : '<p>There\'s nothing new to import. <a href="/holdings">Go to holdings</a></p>'}`;
}

export const doneContent = ({ added, account }) => `<div class="message-view">
    <i class="bi bi-check-circle fs-1 mb-3" aria-hidden="true"></i>
    <h1 class="fs-4">Import finished</h1>
    <p>Added ${added} transaction${added === 1 ? '' : 's'} to ${esc(account)}.</p>
    <a href="/holdings" class="btn btn-outline-primary rounded-pill px-4">See your holdings</a>
</div>`;
