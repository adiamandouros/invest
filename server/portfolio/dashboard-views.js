import { fixed } from '../lib/decimal.js';
import { escapeHtml as esc } from '../pages.js';
import { chart, groupsNow } from './reports-views.js';
import { money, percent } from './views.js';

// The overview: totals, what needs attention, value over time, income per
// month and the allocation (also rendered by test/accessibility.test.js).
// Charts are drawn by public/js/charts.js; each has its figures in a table
// that opens below it.

const eur = (value, signed = false) => money(value, 'EUR', { signed });
const amount = value => (value === null ? null : Number(fixed(value)));
const monthName = month => new Date(`${month}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const DAY_MS = 86_400_000;
const ageInDays = (date, today) => Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS);

// How far a group may be from its target, in percentage points, before the overview says so
export const DRIFT_POINTS = 5;

// What needs a look, as alert HTML. `valuation`: valuation.js valuePortfolio();
// `status`: market_updates; `p2p`: [{ account, lastDate }]; `unassigned`: holdings in no group;
// `allocation`: allocation.js allocation(), for groups that drifted from their targets
export function dashboardNotices({ valuation: v, instruments, status = {}, updating = false, p2p = [], unassigned = [], allocation = null, today }) {
    const notices = [];
    if (updating) notices.push('<div class="alert alert-info" role="status">Updating prices and exchange rates. Reload the page in a minute to see them.</div>');
    const failed = Object.values(status).filter(s => !s.ok && s.message);
    if (failed.length) notices.push(`<div class="alert alert-warning" role="alert">The last price update had problems: ${failed.map(s => esc(s.message)).join('; ')}</div>`);
    if (v.missingPrices.length) {
        notices.push(`<div class="alert alert-warning" role="alert">No price yet for ${v.missingPrices.map(id => `<a href="/instruments/${id}/edit">${esc(instruments.get(id).symbol)}</a>`).join(', ')}, so the totals can't be worked out.</div>`);
    }
    if (v.pricesAsOf && ageInDays(v.pricesAsOf, today) > 5) {
        notices.push(`<div class="alert alert-warning" role="alert">The newest prices are from ${esc(v.pricesAsOf)}, ${ageInDays(v.pricesAsOf, today)} days ago.</div>`);
    }
    const old = p2p.filter(p => p.lastDate && ageInDays(p.lastDate, today) > 40);
    if (old.length) {
        notices.push(`<div class="alert alert-info" role="status">${old.map(p => `${esc(p.account.name)}'s newest row is from ${esc(p.lastDate)}`).join('; ')}. <a href="/import">Import a newer statement</a> to bring ${old.length === 1 ? 'it' : 'them'} up to date.</div>`);
    }
    const drifted = allocation?.ready
        ? allocation.groups.filter(g => g.share !== null && Math.abs(g.share * 100 - Number(g.targetPct) / 1e8) > DRIFT_POINTS) : [];
    if (drifted.length) {
        const describe = g => {
            const points = g.share * 100 - Number(g.targetPct) / 1e8;
            return `${esc(g.name)} is at ${(g.share * 100).toFixed(1)}% against a ${Number(g.targetPct) / 1e8}% target (${points > 0 ? '+' : '−'}${Math.abs(points).toFixed(1)} points)`;
        };
        notices.push(`<div class="alert alert-warning" role="alert">Your allocation has drifted: ${drifted.map(describe).join('; ')}. <a href="/allocation">See how to split your next investment</a> to bring it back.</div>`);
    }
    if (unassigned.length) {
        notices.push(`<div class="alert alert-info" role="status">Not in an allocation group: ${unassigned.map(i => esc(i.name)).join(', ')}. <a href="/allocation/edit">Choose their groups</a>.</div>`);
    }
    return notices;
}

// A table of a chart's figures, closed until asked for
const figures = (summaryText, head, rows) => `<details class="chart-figures">
    <summary>${summaryText}</summary>
    <div class="table-responsive" tabindex="0" role="region" aria-label="${esc(summaryText)}">
        <table class="table table-sm align-middle">
            <thead><tr>${head}</tr></thead>
            <tbody>
${rows}
            </tbody>
        </table>
    </div>
</details>`;
const th = (label, numeric = false) => `<th scope="col"${numeric ? ' class="text-end"' : ''}>${label}</th>`;
const td = (html, numeric = false) => `<td${numeric ? ' class="text-end text-nowrap"' : ''}>${html}</td>`;

// `total`: valuation total; `year`: reports.js year() for this year; `series`,
// `income`: reports.js series() and income(); `groups`: reports.js total().groups or null
export function dashboardContent({ total: t, year, series, income, groups, notices = [] }) {
    if (!series.length) {
        return `<h1 class="fs-3">Overview</h1>
<p>Nothing recorded yet. <a href="/import">Import a statement</a> from Freedom24, Mintos or PeerBerry to start.</p>`;
    }
    const last = series.at(-1);
    const valueLabel = `Value and money put in at the end of each month, from ${monthName(series[0].month)} to ${monthName(last.month)}: now ${fixed(last.valueEur ?? 0n)} EUR against ${fixed(last.investedEur ?? 0n)} EUR put in. The figures are in the table below.`;
    const valueRows = [...series].reverse().map(p => `                <tr>${td(esc(monthName(p.month)))}${td(eur(p.valueEur), true)}${td(eur(p.investedEur), true)}${td(p.valueEur === null || p.investedEur === null ? '—' : eur(p.valueEur - p.investedEur, true), true)}</tr>`).join('\n');

    const recent = income.slice(-24);
    const incomeLabel = `P2P interest and dividends per month for the last ${recent.length} months. The figures are in the table below.`;
    const incomeRows = [...recent].reverse().map(m => `                <tr>${td(esc(monthName(m.month)))}${td(eur(m.interest), true)}${td(eur(m.dividends), true)}${td(eur(m.tax, true), true)}</tr>`).join('\n');

    return `<h1 class="fs-3">Overview</h1>
${notices.join('\n')}
<dl class="summary">
    <div><dt>Value now</dt><dd>${eur(t.valueEur)}</dd></div>
    <div><dt>Put in</dt><dd>${eur(t.investedEur)}</dd></div>
    <div><dt>Gain</dt><dd>${eur(t.gainEur, true)}</dd></div>
    <div><dt>Return a year</dt><dd>${percent(t.xirr)}</dd></div>
</dl>
<h2 class="fs-5 mt-4">This year, so far</h2>
<dl class="summary">
    <div><dt>Gain</dt><dd>${eur(year.gain, true)}</dd></div>
    <div><dt>Return</dt><dd>${percent(year.periodReturn)}</dd></div>
    <div><dt>P2P interest</dt><dd>${eur(year.interest, true)}</dd></div>
    <div><dt>Dividends</dt><dd>${eur(year.dividends, true)}</dd></div>
</dl>
<p><a href="/reports/${year.year}">This year in detail</a> · <a href="/reports">All years</a></p>

<h2 class="fs-5 mt-4" id="value-heading">Value over time</h2>
${chart('value-chart', valueLabel, {
        type: 'line', labels: series.map(p => monthName(p.month)),
        series: [{ name: 'Value', values: series.map(p => amount(p.valueEur)) }, { name: 'Put in', values: series.map(p => amount(p.investedEur)) }],
    })}
${figures('The figures, newest first', th('Month') + th('Value (EUR)', true) + th('Put in (EUR)', true) + th('Gain (EUR)', true), valueRows)}

<h2 class="fs-5 mt-4" id="income-heading">Income per month</h2>
${chart('income-chart', incomeLabel, {
        type: 'bars', labels: recent.map(m => monthName(m.month)),
        series: [{ name: 'P2P interest', values: recent.map(m => amount(m.interest)) }, { name: 'Dividends', values: recent.map(m => amount(m.dividends)) }],
    })}
${figures('The figures, newest first', th('Month') + th('P2P interest (EUR)', true) + th('Dividends (EUR)', true) + th('Tax withheld (EUR)', true), incomeRows)}

${groups?.list.length ? `${groupsNow('groups-now', 'Allocation now', groups)}
<p><a href="/allocation">Allocation and what to invest next</a></p>` : '<h2 class="fs-5 mt-4">Allocation</h2>\n<p><a href="/allocation">Set allocation targets</a> to see how your money is split against them.</p>'}
<p class="small text-secondary-emphasis mt-4">All in EUR. Values use each month's last closing prices and ECB rates; P2P accounts are cash plus loans. Return a year is the money-weighted return (XIRR).</p>`;
}
