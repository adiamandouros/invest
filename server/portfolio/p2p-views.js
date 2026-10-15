import { dec } from '../lib/decimal.js';
import { escapeHtml as esc } from '../pages.js';
import { buttons, decimal, field, summary as errorSummary } from './edit-views.js';
import { money, percent, table, td, th } from './views.js';

// The P2P pages: every P2P account, one account's income and balances, and
// the form for a balance (also rendered by test/accessibility.test.js).
// Summaries come from server/lib/p2p.js summariseP2p().

const small = text => `<br><span class="small text-secondary-emphasis">${text}</span>`;
const monthName = month => new Date(`${month}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const NOTHING_YET = '<p>No P2P accounts yet. <a href="/import">Import a Mintos account statement</a>, or <a href="/accounts/new">add an account</a> of the kind "P2P lending".</p>';

export function p2pListContent({ summaries }) {
    if (!summaries.length) return `<h1 class="fs-3">P2P lending</h1>\n${NOTHING_YET}`;
    const rows = summaries.map(s => `            <tr>
                ${td(`<a href="/p2p/${s.account.id}">${esc(s.account.name)}</a>`)}
                ${td(money(s.value, s.currency), true)}
                ${td(money(s.contributed, s.currency), true)}
                ${td(money(s.gain, s.currency, { signed: true }), true)}
                ${td(percent(s.xirr), true)}
                ${td(s.cash ? money(s.cash.amount, s.currency) + small(`on ${esc(s.cash.date)}`) : '—', true)}
            </tr>`).join('\n');
    return `<h1 class="fs-3">P2P lending</h1>
${table('p2p-heading', 'Accounts', th('Account') + th('Value now', true) + th('Put in', true) + th('Gain', true) + th('Return a year', true) + th('Cash not lent out', true), rows)}
<p class="small text-secondary-emphasis mt-4">Value is cash plus loans at their nominal value, from the imported statements, or from the latest account value you entered plus what happened after it. "Put in" is deposits minus withdrawals. Return a year is the money-weighted return (XIRR).</p>`;
}

function incomeRows(list, label, { cash = false } = {}) {
    return list.map(x => `            <tr>
                ${td(label(x))}
                ${td(money(x.interest, x.currency), true)}
                ${td(x.tax ? money(x.tax, x.currency, { signed: true }) : '—', true)}
                ${td(x.fees ? money(x.fees, x.currency, { signed: true }) : '—', true)}
                ${td(money(x.net, x.currency, { signed: true }), true)}
                ${cash ? td(x.cash === null ? '—' : money(x.cash, x.currency), true) : ''}
            </tr>`).join('\n');
}

export function p2pAccountContent({ summary: s, balances, csrf }) {
    const a = s.account;
    const c = s.currency;
    const notices = [];
    if (s.otherCurrencies.length) {
        notices.push(`<div class="alert alert-warning" role="alert">Rows in ${s.otherCurrencies.map(esc).join(', ')} aren't counted here: this page is in ${esc(c)} only.</div>`);
    }
    const valueNote = s.valuedOn
        ? `from your balance on ${esc(s.valuedOn)}${s.adjustment ? ` (${money(s.adjustment, c, { signed: true })} against the statements)` : ''} and what happened after it`
        : 'cash plus loans, from the statements';

    const withCurrency = list => list.map(x => ({ ...x, currency: c }));
    const yearRows = incomeRows(withCurrency(s.years), y => esc(y.year));
    const totalRow = `            <tr>
                <th scope="row">Total</th>
                ${td(`<strong>${money(s.interest, c)}</strong>`, true)}
                ${td(`<strong>${money(s.tax, c, { signed: true })}</strong>`, true)}
                ${td(`<strong>${money(s.fees, c, { signed: true })}</strong>`, true)}
                ${td(`<strong>${money(s.income, c, { signed: true })}</strong>`, true)}
            </tr>`;
    const monthRows = incomeRows(withCurrency(s.months), m => esc(monthName(m.month)), { cash: true });
    // Statements' month-end cash shows in the monthly table; this lists the values entered by hand
    const entered = balances.filter(b => b.value !== null && b.value !== undefined);
    const balanceRows = [...entered].reverse().map(b => `            <tr>
                ${td(`<span class="text-nowrap">${esc(b.date)}</span>`)}
                ${td(b.value === null ? '—' : money(dec(b.value), c), true)}
                ${td(b.cash === null ? '—' : money(dec(b.cash), c), true)}
                ${td(esc(b.notes ?? ''))}
                ${td(`<form method="post" action="/p2p/${a.id}/balances/${esc(b.date)}/delete">
                    <input type="hidden" name="_csrf" value="${esc(csrf)}">
                    <button type="submit" class="btn btn-link p-0">Delete<span class="visually-hidden"> the balance on ${esc(b.date)}</span></button>
                </form>`)}
            </tr>`).join('\n');
    const incomeHead = th('Interest', true) + th('Tax withheld', true) + th('Fees', true) + th('Net', true);

    return `<h1 class="fs-3">${esc(a.name)}</h1>
<p><a href="/p2p">All P2P accounts</a> · <a href="/transactions?account=${a.id}">Transactions</a> · <a href="/accounts/${a.id}/edit">Edit account</a></p>
${notices.join('\n')}
<dl class="summary">
    <div><dt>Value now</dt><dd>${money(s.value, c)}</dd></div>
    <div><dt>Put in</dt><dd>${money(s.contributed, c)}</dd></div>
    <div><dt>Gain</dt><dd>${money(s.gain, c, { signed: true })}</dd></div>
    <div><dt>Return a year</dt><dd>${percent(s.xirr)}</dd></div>
    ${s.cash ? `<div><dt>Cash not lent out</dt><dd>${money(s.cash.amount, c)}${small(`on ${esc(s.cash.date)}`)}</dd></div>` : ''}
</dl>
<p class="small text-secondary-emphasis">Value now: ${valueNote}.</p>
${s.years.length ? table('years-heading', 'Income by year', th('Year') + incomeHead, `${yearRows}\n${totalRow}`) : '<p>No interest recorded yet.</p>'}
${s.months.length ? table('months-heading', 'Income by month, newest first', th('Month') + incomeHead + th('Cash at the end', true), monthRows) : ''}
<h2 class="fs-5 mt-4" id="balances-heading">Balances</h2>
<p>Enter the account value the platform shows now and then, so losses and write-offs the statements don't list are counted. The latest one replaces the statements' figure from its day on.</p>
<p><a href="/p2p/${a.id}/balances/new" class="btn btn-outline-primary">Add a balance</a></p>
${entered.length ? `<div class="table-responsive">
    <table class="table table-sm align-middle" aria-labelledby="balances-heading">
        <thead><tr>${th('Date') + th('Value', true) + th('Cash', true) + th('Notes')}<th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>
${balanceRows}
        </tbody>
    </table>
</div>` : ''}`;
}

export function balanceForm({ action, values, errors = {}, csrf, account }) {
    const f = { values, errors };
    return `<h1 class="fs-3">Add a balance: ${esc(account.name)}</h1>
${errorSummary(errors)}
<form method="post" action="${action}" class="edit-form" novalidate>
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
${field('date', f, { type: 'date', required: true })}
${field('value', f, { attrs: decimal, required: true, hint: `In ${esc(account.baseCurrency)}: cash plus money in loans, as the platform's overview shows it on that day. A balance already there for the day is replaced.` })}
${field('cash', f, { attrs: decimal, hint: 'Optional: the part that isn\'t lent out.' })}
${field('notes', f, { type: 'textarea' })}
${buttons({ cancel: `/p2p/${account.id}` })}
</form>`;
}
