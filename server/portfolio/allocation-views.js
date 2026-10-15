import { escapeHtml as esc } from '../pages.js';
import { decimal } from './edit-views.js';
import { money, table, td, th } from './views.js';

// The allocation page (targets, the split now, and how to invest an amount)
// and its form (also rendered by test/accessibility.test.js). `result`:
// server/lib/allocation.js allocation().

const pct = share => (share === null ? '—' : `${(share * 100).toFixed(1)}%`);
// Percentage points above (+) or below (−) the target
const points = (share, target) => {
    if (share === null) return '—';
    const d = share * 100 - Number(target) / 1e8;
    const text = Math.abs(d).toFixed(1);
    return Number(text) === 0 ? '0.0 points' : `${d > 0 ? '+' : '−'}${text} points`;
};
const small = text => `<br><span class="small text-secondary-emphasis">${text}</span>`;

export function allocationContent({ result: r, amount = '', error = '' }) {
    const setUp = '<p><a href="/allocation/edit" class="btn btn-outline-primary">Set groups and targets</a></p>';
    if (!r.groups.length) {
        return `<h1 class="fs-3">Allocation</h1>
<p>Split your money into groups, like S&amp;P 500 ETFs, international ETFs and P2P lending, each with the share of the whole you want it to have. This page then shows how far each is from its target, and how to split money you're about to invest to get back to them.</p>
${setUp}`;
    }
    const notices = [];
    if (r.unassigned.length) {
        notices.push(`<div class="alert alert-warning" role="alert">Not in any group, so not counted: ${r.unassigned.map(i => esc(i.name)).join(', ')}. <a href="/allocation/edit">Choose their groups</a>.</div>`);
    }
    if (r.missing.length) notices.push(`<div class="alert alert-warning" role="alert">No value yet for ${r.missing.map(i => esc(i.name)).join(', ')}, so the split can't be worked out. Check its prices on the holdings page.</div>`);
    if (r.targetSum !== 100n * 10n ** 8n) notices.push('<div class="alert alert-warning" role="alert">The targets don\'t add up to 100%. <a href="/allocation/edit">Fix them</a>.</div>');

    const rows = r.groups.map(g => `            <tr>
                ${td(esc(g.name) + (g.items.length ? small(g.items.map(i => `${esc(i.name)} ${money(i.valueEur, 'EUR')}`).join(' · ')) : small('Nothing in it yet')))}
                ${td(money(g.value, 'EUR'), true)}
                ${td(pct(g.share), true)}
                ${td(pct(Number(g.targetPct) / 1e10), true)}
                ${td(points(g.share, g.targetPct) + (g.share === null ? '' : small(money(g.off, 'EUR', { signed: true }))), true)}
            </tr>`).join('\n');
    const total = `            <tr>
                <th scope="row">Total</th>
                ${td(`<strong>${money(r.total, 'EUR')}</strong>`, true)}${td('100%', true)}${td('100%', true)}${td('')}
            </tr>`;

    let plan = '';
    if (r.plan) {
        const p = r.plan;
        const planRows = p.groups.map(g => `            <tr>
                ${td(esc(g.name))}
                ${td(`<strong>${money(g.buy, 'EUR')}</strong>`, true)}
                ${td(money(g.value, 'EUR'), true)}
                ${td(pct(g.share), true)}
                ${td(pct(Number(g.targetPct) / 1e10), true)}
            </tr>`).join('\n');
        plan = `${table('plan-heading', `Investing ${money(p.amount, 'EUR')}`, th('Group') + th('Invest', true) + th('Value after', true) + th('Share after', true) + th('Target', true), planRows)}
<p>${p.exact ? 'This brings every group to its target.' : `This gets as close to the targets as possible without selling anything. To reach them exactly you'd need to invest ${money(p.exactAmount, 'EUR')}.`}</p>`;
    }

    return `<h1 class="fs-3">Allocation</h1>
${notices.join('\n')}
${table('now-heading', 'Now', th('Group') + th('Value (EUR)', true) + th('Share', true) + th('Target', true) + th('Off target', true), `${rows}\n${total}`)}
<h2 class="fs-5 mt-4" id="invest-heading">Invest an amount</h2>
<p>How to split new money so the groups get back to their targets. Nothing is sold: a group above its target gets nothing.</p>
${error ? `<div class="alert alert-danger" role="alert" id="amount-error">${esc(error)}</div>` : ''}
<form method="get" action="/allocation" class="d-flex flex-wrap align-items-end gap-2 mb-3" aria-labelledby="invest-heading">
    <div>
        <label for="amount" class="form-label">Amount to invest (EUR)</label>
        <input id="amount" name="amount" type="text" class="form-control${error ? ' is-invalid' : ''}" value="${esc(amount)}" ${decimal}${error ? ' aria-invalid="true" aria-describedby="amount-error"' : ''}>
    </div>
    <button type="submit" class="btn btn-primary">Work it out</button>
</form>
${plan}
${setUp}
<p class="small text-secondary-emphasis mt-4">Values are today's, as on the holdings page: ETFs at the latest price in EUR, P2P accounts at cash plus loans. Cash waiting at a broker isn't in any group.</p>`;
}

// `groups`: saved groups; `holdings`: [{ key, name, groupId }]; `values`: the
// submitted fields when showing errors
export function allocationForm({ groups, holdings, values = null, errors = {}, csrf }) {
    const rows = Math.max(3, groups.length + 2);
    const v = values ?? Object.fromEntries(groups.flatMap((g, i) => [[`name${i}`, g.name], [`target${i}`, String(Number(g.targetPct))], [`id${i}`, String(g.id)]]));
    const problems = Object.entries(errors).map(([name, message]) => {
        const row = Number(name.match(/\d+$/)?.[0]);
        const label = name === 'total' ? 'Targets' : `Group ${row + 1} ${name.startsWith('name') ? 'name' : 'target'}`;
        return `<li>${name === 'total' ? esc(`${label}: ${message}`) : `<a href="#f-${name}">${esc(label)}: ${esc(message)}</a>`}</li>`;
    });
    const input = (name, label, attrs = '') => {
        const error = errors[name];
        return `<div>
            <label for="f-${name}" class="form-label">${label}</label>
            <input id="f-${name}" name="${name}" type="text" class="form-control${error ? ' is-invalid' : ''}" value="${esc(v[name] ?? '')}" ${attrs}${error ? ` aria-invalid="true" aria-describedby="f-${name}-error"` : ''}>
            ${error ? `<div id="f-${name}-error" class="invalid-feedback d-block">${esc(error)}</div>` : ''}
        </div>`;
    };
    const groupRows = Array.from({ length: rows }, (_, i) => `    <fieldset class="group-row">
        <legend class="fs-6">Group ${i + 1}</legend>
        <input type="hidden" name="id${i}" value="${esc(v[`id${i}`] ?? '')}">
        ${input(`name${i}`, 'Name', 'maxlength="50" autocomplete="off"')}
        ${input(`target${i}`, 'Target (%)', decimal)}
    </fieldset>`).join('\n');
    const options = selected => [['', 'No group'], ...groups.map(g => [String(g.id), g.name])]
        .map(([value, label]) => `<option value="${esc(value)}"${value === String(selected ?? '') ? ' selected' : ''}>${esc(label)}</option>`).join('');
    const holdingRows = holdings.map(h => `    <div class="mb-3">
        <label for="f-group-${h.key}" class="form-label">${esc(h.name)}</label>
        <select id="f-group-${h.key}" name="group-${h.key}" class="form-select">${options(values ? values[`group-${h.key}`] : h.groupId)}</select>
    </div>`).join('\n');

    return `<h1 class="fs-3">Groups and targets</h1>
${problems.length ? `<div class="alert alert-danger" role="alert"><p class="mb-1">Check ${problems.length === 1 ? 'this' : 'these'}:</p><ul class="mb-0">${problems.join('')}</ul></div>` : ''}
<form method="post" action="/allocation" class="edit-form" novalidate>
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <h2 class="fs-5">Groups</h2>
    <p>The targets must add up to 100%. To delete a group, clear its name. Need more groups? Fill the empty rows and save; there are always two more.</p>
${groupRows}
    <h2 class="fs-5 mt-4">What's in each group</h2>
    <p>${groups.length ? 'Your ETFs and P2P accounts. A group you just added appears here once you save.' : 'Save the groups first; then choose here which holdings belong to each.'}</p>
${holdings.length ? holdingRows : '<p>No holdings yet.</p>'}
    <div class="d-flex flex-wrap gap-2 mt-4">
        <button type="submit" class="btn btn-primary">Save</button>
        <a href="/allocation" class="btn btn-outline-primary">Cancel</a>
    </div>
</form>`;
}
