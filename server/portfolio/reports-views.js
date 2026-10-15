import { fixed } from '../lib/decimal.js';
import { escapeHtml as esc } from '../pages.js';
import { money, percent, table, td, th } from './views.js';

// The reports: everything so far with a row per year, and one year in detail
// (also rendered by test/accessibility.test.js). Reports come from
// server/lib/reports.js. Charts are drawn by public/js/charts.js from the JSON
// in a <script type="application/json">, and every chart has a table with
// the same figures.

export const CHART_SCRIPTS = ['/vendor/chart.js/chart.umd.min.js', '/js/charts.js'];

const eur = (value, signed = false) => money(value, 'EUR', { signed });
const pct = share => (share === null || share === undefined ? '—' : `${(share * 100).toFixed(1)}%`);
const targetPct = g => `${(Number(g.targetPct)).toFixed(1).replace(/\.0$/, '')}%`;
const json = data => `<script type="application/json" id="${data.id}-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
export const chart = (id, label, data) => `<div class="chart-box"><canvas id="${id}" data-chart="${id}-data" role="img" aria-label="${esc(label)}"></canvas></div>
${json({ id, ...data })}`;

function summary(r, { xirr = false } = {}) {
    return `<dl class="summary">
    <div><dt>Value at the start</dt><dd>${eur(r.startValue)}</dd></div>
    <div><dt>Put in</dt><dd>${eur(r.putIn, true)}</dd></div>
    <div><dt>Gain</dt><dd>${eur(r.gain, true)}</dd></div>
    <div><dt>Value at the end</dt><dd>${eur(r.endValue)}</dd></div>
    <div><dt>${xirr ? 'Return a year' : 'Return in the period'}</dt><dd>${percent(xirr ? r.xirr : r.periodReturn)}</dd></div>
</dl>`;
}

function incomeTable(id, r) {
    const rows = [
        ['P2P interest', r.interest], ['Dividends', r.dividends], ['Realised gains on sales', r.realised],
        ['Tax withheld', r.tax], ['Fees and commissions', r.fees],
    ].map(([label, value]) => `            <tr>${td(label)}${td(eur(value, true), true)}</tr>`).join('\n');
    return table(id, 'Income and costs', th('Item') + th('EUR', true), rows);
}

function holdingsTable(id, heading, r) {
    const rows = r.holdings.map(h => `            <tr>
                ${td(esc(h.name))}
                ${td(eur(h.startValue), true)}
                ${td(eur(h.putIn, true), true)}
                ${td(eur(h.gain, true), true)}
                ${td(eur(h.endValue), true)}
            </tr>`).join('\n');
    const rest = r.rest !== null && r.rest !== 0n ? `            <tr>${td('Cash, currency moves and fees')}${td('')}${td('')}${td(eur(r.rest, true), true)}${td('')}</tr>` : '';
    const total = `            <tr>
                <th scope="row">Total</th>
                ${td(`<strong>${eur(r.startValue)}</strong>`, true)}
                ${td(`<strong>${eur(r.putIn, true)}</strong>`, true)}
                ${td(`<strong>${eur(r.gain, true)}</strong>`, true)}
                ${td(`<strong>${eur(r.endValue)}</strong>`, true)}
            </tr>`;
    return table(id, heading, th('Holding') + th('At the start', true) + th('Put in', true) + th('Gain', true) + th('At the end', true), [rows, rest, total].filter(Boolean).join('\n'));
}

// The groups' shares on one day: a doughnut and its table
export function groupsNow(id, heading, shares) {
    if (!shares.list.length) return '';
    const list = [...shares.list, ...(shares.other ? [{ name: 'Not in a group', value: shares.other, share: shares.otherShare, targetPct: null }] : [])];
    const rows = list.map(g => `            <tr>${td(esc(g.name))}${td(eur(g.value), true)}${td(pct(g.share), true)}${td(g.targetPct === null ? '—' : targetPct(g), true)}</tr>`).join('\n');
    const label = `${heading}: ${list.map(g => `${g.name} ${pct(g.share)}`).join(', ')}`;
    return `<h2 class="fs-5 mt-4" id="${id}-heading">${esc(heading)}</h2>
<div class="chart-and-table">
${chart(id, label, { type: 'doughnut', labels: list.map(g => g.name), values: list.map(g => (g.value === null ? null : Number(fixed(g.value)))), targets: list.map(g => (g.targetPct === null ? null : Number(g.targetPct))) })}
<div class="table-responsive" tabindex="0" role="region" aria-labelledby="${id}-heading">
    <table class="table table-sm align-middle" aria-labelledby="${id}-heading">
        <thead><tr>${th('Group') + th('Value (EUR)', true) + th('Share', true) + th('Target', true)}</tr></thead>
        <tbody>
${rows}
        </tbody>
    </table>
</div>
</div>`;
}

// Each group's share at the end of each year: stacked bars and their table
function groupsOverTime(id, years) {
    const names = years[0]?.groups.list.map(g => g.name) ?? [];
    if (!names.length) return '';
    const withOther = years.some(y => y.groups.other);
    const ordered = [...years].reverse();
    const shareOf = (y, i) => y.groups.list[i]?.share ?? null;
    const series = names.map((name, i) => ({ name, values: ordered.map(y => (shareOf(y, i) === null ? null : Math.round(shareOf(y, i) * 1000) / 10)) }));
    if (withOther) series.push({ name: 'Not in a group', values: ordered.map(y => (y.groups.otherShare === null ? null : Math.round(y.groups.otherShare * 1000) / 10)) });
    const rows = ordered.map(y => `            <tr>${td(esc(String(y.year)))}${names.map((_, i) => td(pct(shareOf(y, i)), true)).join('')}${withOther ? td(pct(y.groups.otherShare), true) : ''}</tr>`).join('\n');
    return `<h2 class="fs-5 mt-4" id="${id}-heading">Group shares at the end of each year</h2>
<p>With today's group for each holding; the current year ends today.</p>
${chart(id, `Group shares at the end of each year, from ${ordered[0].year} to ${ordered.at(-1).year}. The table below has the figures.`, { type: 'stacked', labels: ordered.map(y => String(y.year)), series })}
<div class="table-responsive" tabindex="0" role="region" aria-labelledby="${id}-heading">
    <table class="table table-sm align-middle" aria-labelledby="${id}-heading">
        <thead><tr>${th('Year')}${names.map(n => th(esc(n), true)).join('')}${withOther ? th('Not in a group', true) : ''}</tr></thead>
        <tbody>
${rows}
        </tbody>
    </table>
</div>`;
}

const NOTHING_YET = '<h1 class="fs-3">Reports</h1>\n<p>Nothing recorded yet. <a href="/import">Import a statement</a> to start.</p>';

export function reportsContent({ total, years }) {
    if (!total) return NOTHING_YET;
    const yearRows = years.map(y => `            <tr>
                ${td(`<a href="/reports/${y.year}">${y.year}</a>`)}
                ${td(eur(y.startValue), true)}
                ${td(eur(y.putIn, true), true)}
                ${td(eur(y.gain, true), true)}
                ${td(percent(y.periodReturn), true)}
                ${td(eur(y.endValue), true)}
                ${td(eur(y.interest, true), true)}
                ${td(eur(y.dividends, true), true)}
                ${td(eur(y.realised, true), true)}
                ${td(eur(y.tax, true), true)}
                ${td(eur(y.fees, true), true)}
            </tr>`).join('\n');
    return `<h1 class="fs-3">Reports</h1>
<p class="no-print"><a href="/reports.csv" class="btn btn-outline-primary">Download the years (CSV)</a></p>
<h2 class="fs-5 mt-4">Everything so far, since ${esc(total.firstDate)}</h2>
${summary(total, { xirr: true })}
${table('years-heading', 'By year', th('Year') + th('At the start', true) + th('Put in', true) + th('Gain', true) + th('Return', true) + th('At the end', true)
        + th('P2P interest', true) + th('Dividends', true) + th('Realised gains', true) + th('Tax withheld', true) + th('Fees', true), yearRows)}
<p class="small text-secondary-emphasis">Return is the money-weighted return within each year (not a yearly rate for the current one). Gain = value at the end − value at the start − money put in.</p>
${groupsNow('groups-now', 'Allocation now', total.groups)}
${groupsOverTime('groups-years', years)}
${holdingsTable('holdings-heading', 'By holding, since the start', total)}
${incomeTable('income-heading', total)}
<p class="small text-secondary-emphasis mt-4">All in EUR at the rate on each day. Values use the last closing price on or before the day; P2P accounts are cash plus loans. For tax, check the figures with an accountant.</p>`;
}

export function yearContent({ report: r, years }) {
    const others = years.filter(y => y !== r.year).map(y => `<a href="/reports/${y}">${y}</a>`).join(' · ');
    return `<h1 class="fs-3">${r.year}</h1>
<p class="no-print"><a href="/reports">All years</a>${others ? ` · ${others}` : ''} · <a href="/reports/${r.year}.csv">Download (CSV)</a></p>
<p>From ${esc(r.from)} to ${esc(r.to)}.</p>
${summary(r)}
${holdingsTable('holdings-heading', 'By holding', r)}
${incomeTable('income-heading', r)}
${groupsNow('groups-end', `Allocation on ${r.to}`, r.groups)}`;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

const cell = value => {
    const text = value === null || value === undefined ? '' : typeof value === 'bigint' ? fixed(value) : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csv = rows => `${rows.map(r => r.map(cell).join(',')).join('\r\n')}\r\n`;
const rate = value => (value === null || value === undefined ? null : (value * 100).toFixed(2));

export function yearsCsv(years) {
    return csv([
        ['Year', 'From', 'To', 'Value at start (EUR)', 'Put in (EUR)', 'Gain (EUR)', 'Return (%)', 'Value at end (EUR)',
            'P2P interest (EUR)', 'Dividends (EUR)', 'Realised gains (EUR)', 'Tax withheld (EUR)', 'Fees (EUR)'],
        ...years.map(y => [y.year, y.from, y.to, y.startValue, y.putIn, y.gain, rate(y.periodReturn), y.endValue,
            y.interest, y.dividends, y.realised, y.tax, y.fees]),
    ]);
}

export function yearCsv(r) {
    return csv([
        ['Holding', 'Value at start (EUR)', 'Put in (EUR)', 'Gain (EUR)', 'Value at end (EUR)'],
        ...r.holdings.map(h => [h.name, h.startValue, h.putIn, h.gain, h.endValue]),
        ['Cash, currency moves and fees', null, null, r.rest, null],
        ['Total', r.startValue, r.putIn, r.gain, r.endValue],
        [],
        ['Item', 'EUR'],
        ['P2P interest', r.interest], ['Dividends', r.dividends], ['Realised gains on sales', r.realised],
        ['Tax withheld', r.tax], ['Fees and commissions', r.fees],
    ]);
}
