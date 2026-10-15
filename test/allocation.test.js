import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { allocation } from '../server/lib/allocation.js';
import { dec, fixed } from '../server/lib/decimal.js';
import { parseAllocation } from '../server/portfolio/forms.js';
import { csrfOf, location, signUp, start } from './helpers/app.js';

const GROUPS = [{ id: 1, name: 'S&P 500', targetPct: '60' }, { id: 2, name: 'International', targetPct: '10' }, { id: 3, name: 'P2P', targetPct: '30' }];
const items = values => values.map(([key, groupId, v]) => ({ key, name: key, groupId, valueEur: v === null ? null : dec(v) }));
const ITEMS = items([['VUAA', 1, '65'], ['VWRA', 2, '10'], ['Mintos', 3, '20'], ['PeerBerry', 3, '12']]);

test('the split now, against the targets', () => {
    const r = allocation({ groups: GROUPS, items: ITEMS });
    assert.equal(r.ready, true);
    assert.equal(fixed(r.total), '107.00');
    assert.deepEqual(r.groups.map(g => [g.name, fixed(g.value), (g.share * 100).toFixed(1), fixed(g.off)]), [
        ['S&P 500', '65.00', '60.7', '0.80'],
        ['International', '10.00', '9.3', '-0.70'],
        ['P2P', '32.00', '29.9', '-0.10'],
    ]);
    assert.equal(r.plan, null);
});

test('new money is split to bring the groups back to their targets', () => {
    const plan = allocation({ groups: GROUPS, items: ITEMS, amount: dec('10') }).plan;
    assert.deepEqual(plan.groups.map(g => [fixed(g.buy), fixed(g.value), (g.share * 100).toFixed(1)]),
        [['5.20', '70.20', '60.0'], ['1.70', '11.70', '10.0'], ['3.10', '35.10', '30.0']]);
    assert.equal(plan.exact, true);
    assert.equal(fixed(plan.exactAmount), '1.33', 'from 65 / 0.6 − 107');
});

test('nothing is sold: too little money goes to the groups below target', () => {
    const plan = allocation({ groups: GROUPS, items: ITEMS, amount: dec('1') }).plan;
    assert.deepEqual(plan.groups.map(g => fixed(g.buy)), ['0.00', '0.75', '0.25']);
    assert.equal(plan.exact, false);
    // Far above target: the others share everything
    const heavy = allocation({ groups: GROUPS, items: items([['VUAA', 1, '900'], ['VWRA', 2, '10'], ['P2P', 3, '30']]), amount: dec('100') }).plan;
    assert.deepEqual(heavy.groups.map(g => fixed(g.buy)), ['0.00', '25.00', '75.00']);
    // Cents always add up to the amount
    const odd = allocation({ groups: GROUPS, items: ITEMS, amount: dec('0.07') }).plan;
    assert.equal(fixed(odd.groups.reduce((s, g) => s + g.buy, 0n)), '0.07');
});

test('holdings without a group or a value, and targets that don\'t add up', () => {
    const r = allocation({ groups: GROUPS, items: [...ITEMS, { key: 'VTI', name: 'VTI', groupId: null, valueEur: dec('5') }], amount: dec('10') });
    assert.deepEqual(r.unassigned.map(i => i.name), ['VTI']);
    assert.equal(fixed(r.total), '107.00', 'not counted');
    const missing = allocation({ groups: GROUPS, items: items([['VUAA', 1, null]]), amount: dec('10') });
    assert.equal(missing.ready, false);
    assert.equal(missing.plan, null);
    assert.equal(allocation({ groups: [{ ...GROUPS[0], targetPct: '50' }], items: ITEMS, amount: dec('10') }).plan, null);
});

test('the allocation form: groups, targets adding up to 100, and holdings', () => {
    const holdings = [{ key: 'i1' }, { key: 'a2' }];
    const saved = [{ id: 7, name: 'Old', targetPct: '100' }];
    const ok = parseAllocation({
        name0: 'S&P 500', target0: '60', id0: '', name1: 'International', target1: '10,5', id1: '',
        name2: 'P2P', target2: '29.5', id2: '', name3: '', target3: '', id3: '7', 'group-i1': '7', 'group-a2': '',
    }, { groups: saved, holdings });
    assert.deepEqual(ok.errors, {});
    assert.deepEqual(ok.values.groups.map(g => [g.name, g.targetPct]), [['S&P 500', '60'], ['International', '10.5'], ['P2P', '29.5']]);
    assert.deepEqual(ok.values.removed, [7], 'a cleared name deletes the group');
    assert.deepEqual(ok.values.instruments, [[1, null]], 'a holding in a deleted group has none');

    const bad = parseAllocation({ name0: 'A', target0: '50', name1: 'a', target1: 'x' }, { groups: [], holdings });
    assert.deepEqual(Object.keys(bad.errors), ['name1', 'target1']);
    assert.match(parseAllocation({ name0: 'A', target0: '50' }, { groups: [], holdings }).errors.total, /add up to 50%/);
    assert.match(parseAllocation({ name0: '' }, { groups: [], holdings }).errors.name0, /at least one/);
});

test('the allocation pages: set groups, assign holdings, work out an amount', async () => {
    const app = await start();
    app.clock.now = Date.parse('2025-12-31T12:00:00Z');
    try {
        const b = app.browser();
        assert.equal(location(await b.get('/allocation')), '/login');
        await signUp(b, app.clock);
        // A Mintos account worth 405.41 (test/fixtures/mintos-statement.csv)
        const importForm = await (await b.get('/import')).text();
        const form = new FormData();
        form.append('_csrf', csrfOf(importForm));
        form.append('statement', new Blob([readFileSync(new URL('./fixtures/mintos-statement.csv', import.meta.url))]), 's.csv');
        const preview = await (await b.post('/import/preview', form)).text();
        await b.post('/import/confirm', { _csrf: csrfOf(preview), id: preview.match(/name="id" value="([^"]+)"/)[1] });

        assert.match(await (await b.get('/allocation')).text(), /Set groups and targets/);
        const edit = await (await b.get('/allocation/edit')).text();
        assert.match(edit, /Save the groups first/);
        const bad = await b.post('/allocation', { _csrf: csrfOf(edit), name0: 'ETFs', target0: '60', name1: 'P2P', target1: '30', name2: '', target2: '' });
        assert.equal(bad.status, 400);
        assert.match(await bad.text(), /add up to 90%/);
        assert.equal(location(await b.post('/allocation', { _csrf: csrfOf(edit), name0: 'ETFs', target0: '70', name1: 'P2P', target1: '30', name2: '', target2: '' })), '/allocation');
        assert.deepEqual(app.data.groups.map(g => [g.id, g.name, g.targetPct]), [[1, 'ETFs', '70'], [2, 'P2P', '30']]);

        const again = await (await b.get('/allocation/edit')).text();
        assert.match(again, /<label for="f-group-a1" class="form-label">Mintos<\/label>/);
        await b.post('/allocation', { _csrf: csrfOf(again), name0: 'ETFs', target0: '70', id0: '1', name1: 'P2P', target1: '30', id1: '2', 'group-a1': '2' });
        assert.equal(app.data.accounts[0].allocationGroupId, 2);

        const page = await (await b.get('/allocation?amount=100')).text();
        assert.match(page, /€405\.41/);
        assert.match(page, /Investing €100\.00/);
        assert.match(page, /need to invest €945\.96/);
        assert.equal((await b.get('/allocation?amount=-5')).status, 400);
    } finally {
        app.close();
    }
});
