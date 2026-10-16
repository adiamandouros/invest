import { escapeHtml as esc } from '../pages.js';
import { decimal } from './edit-views.js';
import { chart } from './reports-views.js';
import { money, percent, table, td, th } from './views.js';

// The projection page: each group's past, the assumptions (prefilled from
// it), and where the groups could be in some years (also rendered by
// test/accessibility.test.js). `history`: reports.js groupHistory();
// `projection`: projection.js project(), or null.

const whole = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur = value => esc(whole.format(value).replace('-', '−'));
const keyOf = g => (g.id === null ? 'none' : String(g.id));

function field(name, label, values, errors, { hint = '', attrs = decimal } = {}) {
    const id = `f-${name}`;
    const error = errors[name];
    const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');
    return `    <div class="mb-3">
        <label for="${id}" class="form-label">${label}</label>
        <input id="${id}" name="${name}" type="text" class="form-control${error ? ' is-invalid' : ''}" value="${esc(values[name] ?? '')}" ${attrs}${described ? ` aria-describedby="${described}"` : ''}${error ? ' aria-invalid="true"' : ''}>
        ${hint ? `<div id="${id}-hint" class="form-text">${hint}</div>` : ''}
        ${error ? `<div id="${id}-error" class="invalid-feedback d-block">${esc(error)}</div>` : ''}
    </div>`;
}

// `values`: the form's fields as text; `split`: how the monthly amount is shared, as text
// `plan`: { goal, year, monthly, safer } for a goal, or null
export function projectionContent({ history, values, errors = {}, projection = null, split = '', thisYear, plan = null }) {
    if (!history.length) {
        const goalSection = !plan ? '' : `<h2 class="fs-5 mt-4" id="goal-heading">To reach ${eur(plan.goal)} by ${plan.year}</h2>
${plan.monthly === 0 ? `<p>You'd get there without adding anything, at the returns you expect.</p>`
        : plan.monthly === null ? '<p>There\'s nothing yet for monthly amounts to go into: set allocation targets, or hold something first.</p>'
            : `<dl class="summary">
    <div><dt>Invest each month</dt><dd>${eur(Math.ceil(plan.monthly))}</dd></div>
    <div><dt>To be safer</dt><dd>${plan.safer === 0 ? eur(0) : eur(Math.ceil(plan.safer))}</dd></div>
</dl>
<p class="small text-secondary-emphasis">At the returns above, shared out ${esc(split || 'as above')}. "To be safer" is what it takes at the lower estimate, which about five times in six you'd beat.</p>`}`;

    return `<h1 class="fs-3">Projection</h1>
<p>Nothing recorded yet. <a href="/import">Import a statement</a> to start.</p>`;
    }
    const pastRows = history.map(g => `            <tr>
                ${td(esc(g.name))}
                ${td(money(g.value, 'EUR'), true)}
                ${td(percent(g.xirr), true)}
                ${td(g.years.length ? g.years.map(y => `${y.year}: ${percent(y.rate)}`).join('<br>') : '—', true)}
            </tr>`).join('\n');

    const form = `<form method="get" action="/projection" class="edit-form" novalidate aria-labelledby="assumptions-heading">
${field('years', 'Years ahead', values, errors, { attrs: 'inputmode="numeric" autocomplete="off"', hint: 'From 1 to 50.' })}
${field('monthly', 'Invested each month (EUR)', values, errors, { hint: split ? `Shared out ${esc(split)}.` : '' })}
    <fieldset>
        <legend class="fs-6">Expected return a year, per group (%)</legend>
${history.map(g => field(`rate-${keyOf(g)}`, esc(g.name), values, errors, {
        hint: g.xirr === null ? 'No return to go by yet.' : `So far: ${percent(g.xirr)} a year.`,
    })).join('\n')}
    </fieldset>
    <fieldset>
        <legend class="fs-6">A goal (optional)</legend>
${field('goal', 'Amount to reach (EUR)', values, errors, { hint: 'In total, everything included, like 100000.' })}
${field('goalYear', 'By the end of', values, errors, { attrs: 'inputmode="numeric" autocomplete="off"', hint: `A year from ${thisYear + 1}.` })}
    </fieldset>
    <button type="submit" class="btn btn-primary">Project</button>
</form>`;

    let results = '';
    if (projection) {
        const last = projection.at(-1);
        const years = last.year;
        const head = th('Year') + history.map(g => th(esc(g.name), true)).join('') + th('Total', true) + th('Range', true) + th('Added so far', true);
        const rows = projection.slice(1).map(p => `            <tr>
                ${td(String(thisYear + p.year))}
                ${p.groups.map(g => td(eur(g.mid), true)).join('')}
                ${td(`<strong>${eur(p.total.mid)}</strong>`, true)}
                ${td(p.total.low === p.total.high ? '—' : `${eur(p.total.low)} to ${eur(p.total.high)}`, true)}
                ${td(eur(p.contributed), true)}
            </tr>`).join('\n');
        const label = `Projected value of each group at the end of each year, from ${thisYear + 1} to ${thisYear + years}, reaching ${whole.format(last.total.mid)} in total. The table below has the figures.`;
        results = `<h2 class="fs-5 mt-4" id="result-heading">In ${years} year${years === 1 ? '' : 's'}, in ${thisYear + years}</h2>
<dl class="summary">
    <div><dt>Projected value</dt><dd>${eur(last.total.mid)}</dd></div>
    <div><dt>Lower estimate</dt><dd>${eur(last.total.low)}</dd></div>
    <div><dt>Higher estimate</dt><dd>${eur(last.total.high)}</dd></div>
    <div><dt>Of which added</dt><dd>${eur(last.contributed)}</dd></div>
</dl>
${chart('projection-chart', label, {
        type: 'bars', labels: projection.slice(1).map(p => String(thisYear + p.year)),
        series: history.map((g, i) => ({ name: g.name, values: projection.slice(1).map(p => Math.round(p.groups[i].mid)) })),
    })}
${table('projection-heading', 'Year by year', head, rows)}
<p class="small text-secondary-emphasis">The lower and higher estimates allow for each group's return being higher or lower than expected, by as much as its yearly returns have varied so far, narrowing over longer spans as good and bad years even out. About two times in three the outcome would land between them. With only a few years of history the range is rough, and a group with less than two whole years has none. Money is added at the end of each month. In today's euros, before inflation and tax.</p>`;
    }

    const goalSection = !plan ? '' : `<h2 class="fs-5 mt-4" id="goal-heading">To reach ${eur(plan.goal)} by ${plan.year}</h2>
${plan.monthly === 0 ? `<p>You'd get there without adding anything, at the returns you expect.</p>`
        : plan.monthly === null ? '<p>There\'s nothing yet for monthly amounts to go into: set allocation targets, or hold something first.</p>'
            : `<dl class="summary">
    <div><dt>Invest each month</dt><dd>${eur(Math.ceil(plan.monthly))}</dd></div>
    <div><dt>To be safer</dt><dd>${plan.safer === 0 ? eur(0) : eur(Math.ceil(plan.safer))}</dd></div>
</dl>
<p class="small text-secondary-emphasis">At the returns above, shared out ${esc(split || 'as above')}. "To be safer" is what it takes at the lower estimate, which about five times in six you'd beat.</p>`}`;

    return `<h1 class="fs-3">Projection</h1>
<p>Where your groups could be in some years, if each grows at the return you expect and you keep investing. Past returns are prefilled; they're a guide, not a promise, and a few good years can make them look higher than is likely over the long run.</p>
${table('past-heading', 'So far', th('Group') + th('Value now', true) + th('Return a year since the start', true) + th('Each whole year', true), pastRows)}
<p class="small text-secondary-emphasis">With each holding in its group today. The first, partial year of each group is left out of the yearly returns.</p>
<h2 class="fs-5 mt-4" id="assumptions-heading">Your assumptions</h2>
${form}
${goalSection}
${results}`;
}
