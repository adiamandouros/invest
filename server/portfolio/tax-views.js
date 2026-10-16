import { fixed } from '../lib/decimal.js';
import { escapeHtml as esc } from '../pages.js';
import { decimal } from './edit-views.js';
import { money, table, td, th } from './views.js';

// The tax summary for one year (also rendered by test/accessibility.test.js).
// `t`: server/lib/tax.js taxYear().

const eur = (value, signed = false) => money(value, 'EUR', { signed });
const ratePct = rate => fixed(rate * 100n, 2).replace(/\.?0+$/, '');

const kindOf = e => (e.instrument.kind !== 'etf' ? 'Share' : e.ucits ? 'UCITS fund' : e.ucits === false ? 'Not UCITS' : 'Not sure');

function rateField(name, label, value, error) {
    return `    <div>
        <label for="${name}" class="form-label">${label}</label>
        <input id="${name}" name="${name}" type="text" class="form-control${error ? ' is-invalid' : ''}" value="${esc(value)}" ${decimal}${error ? ` aria-invalid="true" aria-describedby="${name}-error"` : ''}>
        ${error ? `<div id="${name}-error" class="invalid-feedback d-block">${esc(error)}</div>` : ''}
    </div>`;
}

// `rateText`, `dividendRateText`: the form's fields; `errors`: { rate, dividendRate }
export function taxContent({ t, years, rateText, dividendRateText = '5', errors = {} }) {
    const others = years.filter(y => y !== t.year).map(y => `<a href="/tax/${y}">${y}</a>`).join(' · ');
    const p2pRows = t.p2p.map(p => `            <tr>
                ${td(esc(p.account.name))}
                ${td(eur(p.interest), true)}
                ${td(eur(p.withheld), true)}
                ${td(eur(p.greekTax), true)}
                ${td(eur(p.credit), true)}
                ${td(eur(p.due), true)}
                ${td(eur(p.fees), true)}
            </tr>`).join('\n');
    const p2pTotal = `            <tr>
                <th scope="row">Total</th>
                ${['interest', 'withheld', 'greekTax', 'credit', 'due', 'fees'].map(k => td(`<strong>${eur(t.p2pTotal[k])}</strong>`, true)).join('')}
            </tr>`;
    const etfRows = t.etfs.map(e => `            <tr>
                ${td(`${esc(e.instrument.symbol)}<br><span class="small text-secondary-emphasis">${esc(e.instrument.name)}</span>`)}
                ${td(kindOf(e))}
                ${td(eur(e.dividends), true)}
                ${td(eur(e.withheld), true)}
                ${td(e.sold ? eur(e.realised, true) : '—', true)}
            </tr>`).join('\n');
    const etfTotal = `            <tr>
                <th scope="row">Total</th>${td('')}
                ${td(`<strong>${eur(t.etfTotal.dividends)}</strong>`, true)}${td(`<strong>${eur(t.etfTotal.withheld)}</strong>`, true)}${td(`<strong>${eur(t.etfTotal.realised, true)}</strong>`, true)}
            </tr>`;

    return `<h1 class="fs-3">Tax summary ${t.year}</h1>
<p class="no-print">${others ? `${others} · ` : ''}<a href="/tax/${t.year}.csv?rate=${encodeURIComponent(rateText)}&amp;dividendRate=${encodeURIComponent(dividendRateText)}">Download (CSV)</a></p>
<p>The figures for your Greek tax return (E1) for income in ${t.year}, in EUR at the ECB rate on each day. The tax is an estimate to check against what the platforms' tax reports say and what the tax office works out.</p>

<h2 class="fs-5 mt-4" id="p2p-heading">Interest from P2P lending abroad</h2>
<form method="get" action="/tax/${t.year}" class="d-flex flex-wrap align-items-end gap-2 mb-3 no-print" aria-label="Tax rates">
${rateField('rate', 'Greek tax on interest (%)', rateText, errors.rate)}
${rateField('dividendRate', 'Greek tax on dividends (%)', dividendRateText, errors.dividendRate)}
    <button type="submit" class="btn btn-outline-primary">Work it out again</button>
</form>
${t.p2p.length ? table('p2p-table-heading', 'Per platform', th('Platform') + th('Interest', true) + th('Withheld abroad', true) + th(`Greek tax at ${esc(ratePct(t.rate))}%`, true)
        + th('Less what was withheld', true) + th('Left to pay', true) + th('Fees', true), `${p2pRows}\n${p2pTotal}`)
        : '<p>No P2P interest this year.</p>'}
<p class="small text-secondary-emphasis">Interest includes late fees, bonuses and interest on bought-back loans, before any tax. Tax withheld abroad counts against the Greek tax on the same interest, up to that tax. The platforms' fees usually can't be deducted; they're here for completeness.</p>

<h2 class="fs-5 mt-4" id="etf-heading">ETFs and shares</h2>
${t.etfs.length ? table('etf-table-heading', 'Dividends and sales', th('Holding') + th('Kind') + th('Dividends', true) + th('Tax withheld', true) + th('Realised gain on sales', true), `${etfRows}\n${etfTotal}`)
        : '<p>No dividends or sales this year.</p>'}
<p class="small text-secondary-emphasis">Income from UCITS funds (European funds, like an IE or LU ISIN) is tax-free in Greece; it's here for your records. Funds from elsewhere, like US-listed ETFs, aren't UCITS. "Not sure" means the ISIN doesn't tell: check the fund's documents. Realised gains use the oldest shares first (FIFO), with fees, in EUR at the rate on each day.</p>
${t.taxed.length ? `${table('dividends-heading', 'Dividends taxed in Greece', th('Holding') + th('Dividends', true) + th('Withheld abroad', true) + th(`Greek tax at ${esc(ratePct(t.dividendRate))}%`, true) + th('Less what was withheld', true) + th('Left to pay', true),
        `${t.taxed.map(e => `            <tr>${td(esc(e.instrument.symbol))}${td(eur(e.dividends), true)}${td(eur(e.withheld), true)}${td(eur(e.dividendTax), true)}${td(eur(e.credit), true)}${td(eur(e.due), true)}</tr>`).join('\n')}
            <tr><th scope="row">Total</th>${['dividends', 'withheld', 'dividendTax', 'credit', 'due'].map(k => td(`<strong>${eur(t.taxedTotal[k])}</strong>`, true)).join('')}</tr>`)}
<p class="small text-secondary-emphasis">Dividends from funds that aren't UCITS, and from shares, go on the return. Tax withheld abroad counts against the Greek tax on them, up to that tax, so with 15% or 30% US withholding there's usually nothing left to pay.</p>` : ''}`;
}

const cell = value => {
    const text = value === null || value === undefined ? '' : typeof value === 'bigint' ? fixed(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function taxCsv(t) {
    const rows = [
        [`Tax summary ${t.year}`, `Greek tax on interest ${ratePct(t.rate)}%`, `on dividends ${ratePct(t.dividendRate)}%`],
        [],
        ['P2P platform', 'Interest (EUR)', 'Withheld abroad (EUR)', 'Greek tax (EUR)', 'Less what was withheld (EUR)', 'Left to pay (EUR)', 'Fees (EUR)'],
        ...t.p2p.map(p => [p.account.name, p.interest, p.withheld, p.greekTax, p.credit, p.due, p.fees]),
        ['Total', t.p2pTotal.interest, t.p2pTotal.withheld, t.p2pTotal.greekTax, t.p2pTotal.credit, t.p2pTotal.due, t.p2pTotal.fees],
        [],
        ['Holding', 'ISIN', 'Kind', 'Dividends (EUR)', 'Tax withheld (EUR)', 'Realised gain (EUR)', `Greek tax at ${ratePct(t.dividendRate)}% (EUR)`, 'Less what was withheld (EUR)', 'Left to pay (EUR)'],
        ...t.etfs.map(e => [e.instrument.symbol, e.instrument.isin, kindOf(e), e.dividends, e.withheld, e.sold ? e.realised : null, e.dividendTax, e.credit, e.due]),
        ['Total', null, null, t.etfTotal.dividends, t.etfTotal.withheld, t.etfTotal.realised, t.taxedTotal.dividendTax, t.taxedTotal.credit, t.taxedTotal.due],
    ];
    return `${rows.map(r => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
