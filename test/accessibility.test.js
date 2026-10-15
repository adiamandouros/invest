import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { codePage, loginPage, setupPage } from '../server/auth/views.js';
import { readFileSync as read } from 'fs';
import { applyImport, parseStatement, planImport } from '../server/import/index.js';
import { createPrices, createRates, valuePortfolio } from '../server/lib/valuation.js';
import { createRenderer, messagePage, renderPages } from '../server/pages.js';
import {
    accountForm, accountsContent, deleteTransactionContent, instrumentForm, instrumentsContent, transactionForm,
} from '../server/portfolio/edit-views.js';
import { allocation } from '../server/lib/allocation.js';
import { dec } from '../server/lib/decimal.js';
import { summariseP2p } from '../server/lib/p2p.js';
import { createReports } from '../server/lib/reports.js';
import { reportsContent, yearContent } from '../server/portfolio/reports-views.js';
import { dashboardContent, dashboardNotices } from '../server/portfolio/dashboard-views.js';
import { allocationContent, allocationForm } from '../server/portfolio/allocation-views.js';
import { balanceForm, p2pAccountContent, p2pListContent } from '../server/portfolio/p2p-views.js';
import { doneContent, holdingsContent, importContent, previewContent, transactionsContent } from '../server/portfolio/views.js';
import { createMemoryData } from './helpers/memory-data.js';

// Accessibility checks on every page as the server sends it (WCAG 2.2 AA
// basics), and on the colours in style.css. Run axe-core in a real browser
// as well before calling new UI done.

const render = createRenderer();
const session = { stage: 'full', csrf: 'token' };
const { pages, notFound } = renderPages(render, session);

// The portfolio pages with the made-up report imported
const data = createMemoryData();
const statement = parseStatement(read(new URL('./fixtures/freedom24-report.json', import.meta.url), 'utf8'));
const plan = await planImport(statement, data);
await applyImport(plan, data);
const instrument = id => data.instruments.find(i => i.id === id);
const valuation = valuePortfolio({
    transactions: data.transactions.map(t => ({ ...t, account: t.accountId, instrument: t.instrumentId })),
    priceOf: createPrices([{ instrumentId: 1, date: '2026-10-15', close: '149.5', currency: 'USD' }]),
    eurPer: createRates([{ currency: 'USD', date: '2022-01-03', perEur: '1.13' }]),
    today: '2026-10-15',
});
const page = (title, content) => render({ title, content, session });

const allocationGroups = [{ id: 1, name: 'S&P 500', targetPct: '60' }, { id: 2, name: 'International', targetPct: '10' }, { id: 3, name: 'P2P', targetPct: '30' }];
const allocationItems = [['i1', 'VUAA.EU', 1, '65'], ['i2', 'VWRA.EU', 2, '10'], ['a2', 'Mintos', 3, '32']]
    .map(([key, name, groupId, v]) => ({ key, name, groupId, valueEur: dec(v) }));

// A Mintos account from the made-up statement, with a balance entered by hand
const mintos = parseStatement(read(new URL('./fixtures/mintos-statement.csv', import.meta.url), 'utf8'));
const mintosPlan = await planImport(mintos, data);
await applyImport(mintosPlan, data);
const p2pAccount = data.accounts.find(a => a.kind === 'p2p');
await data.saveBalance({ accountId: p2pAccount.id, date: '2025-03-31', value: '400.41', cash: null, notes: 'From the overview' });
const p2pSummary = summariseP2p({
    account: p2pAccount, rows: data.transactions.filter(t => t.accountId === p2pAccount.id),
    balances: await data.listBalances({ accountId: p2pAccount.id }), today: '2026-10-15',
});

// Reports over everything imported above, with the P2P accounts in a group
await data.saveAllocation({ groups: [{ id: null, name: 'P2P lending', targetPct: '100' }], removed: [], instruments: [], accounts: [[p2pAccount.id, 1]] });
const reports = createReports({
    transactions: data.transactions, accounts: new Map(data.accounts.map(a => [a.id, a])), instruments: new Map(data.instruments.map(i => [i.id, i])),
    balances: data.balances, groups: data.groups, today: '2026-10-15',
    priceOf: createPrices([{ instrumentId: 1, date: '2026-10-15', close: '149.5', currency: 'USD' }]),
    eurPer: createRates([{ currency: 'USD', date: '2022-01-03', perEur: '1.13' }]),
});

const all = {
    ...pages,
    '/holdings': page('Holdings', holdingsContent({
        valuation, csrf: 'token', updating: true,
        instruments: new Map(data.instruments.map(i => [i.id, i])),
        accounts: new Map(data.accounts.map(a => [a.id, a])),
        status: { prices: { ok: false, message: 'VTI.US: not found' } },
    })),
    '/holdings (empty)': page('Holdings', holdingsContent({
        valuation: { positions: [], cash: [], total: {}, missingPrices: [] }, instruments: new Map(), accounts: new Map(), csrf: 'token',
    })),
    '/transactions': page('Transactions', transactionsContent({
        rows: data.transactions.map(t => ({ ...t, account: data.accounts[0], instrument: instrument(t.instrumentId) ?? null })),
        instrument: data.instruments[0],
    })),
    '/allocation': page('Allocation', allocationContent({ amount: '10', result: allocation({
        groups: allocationGroups, amount: dec('10'),
        items: [...allocationItems, { key: 'i9', name: 'VTI.US', groupId: null, valueEur: dec('5') }],
    }) })),
    '/allocation (empty, bad amount)': page('Allocation', allocationContent({ result: allocation({ groups: [], items: [] }), amount: 'x', error: 'Enter an amount above zero, like 500.' })),
    '/allocation/edit (errors)': page('Groups and targets', allocationForm({
        groups: allocationGroups, holdings: allocationItems, csrf: 'token',
        values: { name0: 'S&P 500', target0: '60', name1: 'International', target1: 'x' },
        errors: { target1: 'Enter a percentage from 0 to 100.', total: 'The targets add up to 60%; make them add up to 100%.' },
    })),
    '/ (overview)': page('Overview', dashboardContent({
        total: valuation.total, year: reports.year(2026), series: reports.series(), income: reports.income(), groups: reports.total().groups,
        notices: dashboardNotices({
            valuation, instruments: new Map(data.instruments.map(i => [i.id, i])), today: '2026-10-15', updating: true,
            p2p: [{ account: p2pAccount, lastDate: '2025-03-31' }], unassigned: [{ name: 'VTI.US' }],
        }),
    })),
    '/ (overview, empty)': page('Overview', dashboardContent({ total: {}, year: null, series: [], income: [], groups: null })),
    '/reports': render({ title: 'Reports', session, content: reportsContent({ total: { ...reports.total(), firstDate: reports.firstDate }, years: reports.years.map(reports.year) }) }),
    '/reports (empty)': page('Reports', reportsContent({ total: null, years: [] })),
    '/reports/2025': page('Report 2025', yearContent({ report: reports.year(2025), years: reports.years })),
    '/p2p': page('P2P lending', p2pListContent({ summaries: [p2pSummary] })),
    '/p2p (empty)': page('P2P lending', p2pListContent({ summaries: [] })),
    '/p2p/2': page('Mintos', p2pAccountContent({ summary: { ...p2pSummary, otherCurrencies: ['USD'] }, balances: await data.listBalances({ accountId: p2pAccount.id }), csrf: 'token' })),
    '/p2p/2/balances/new (errors)': page('Add a balance', balanceForm({
        action: '/p2p/2/balances', csrf: 'token', account: p2pAccount, values: { value: 'lots' }, errors: { value: 'Enter a number.', date: 'Enter a date.' },
    })),
    '/import/preview (Mintos)': page('Check the import', previewContent({ plan: { ...mintosPlan, updates: [{ id: 1 }] }, csrf: 'token', id: 'x' })),
    '/import': page('Import', importContent({ csrf: 'token', error: 'The file isn\'t valid JSON.' })),
    '/import/preview': page('Check the import', previewContent({ plan: { ...plan, warnings: ['A row to look at'] }, csrf: 'token', id: 'x' })),
    '/import/confirm': page('Import finished', doneContent({ added: 18, account: 'Freedom24' })),
    '/transactions/new (errors)': page('Add a transaction', transactionForm({
        action: '/transactions', csrf: 'token', accounts: data.accounts, instruments: data.instruments,
        values: { type: 'buy', units: 'two' }, errors: { units: 'Enter a number.', date: 'Enter a date.' },
    })),
    '/transactions/1/edit': page('Edit transaction', transactionForm({
        action: '/transactions/1', csrf: 'token', accounts: data.accounts, instruments: data.instruments,
        transaction: data.transactions[0], values: { type: 'buy' },
    })),
    '/transactions/1/delete': page('Delete transaction', deleteTransactionContent({ transaction: data.transactions[0], csrf: 'token', description: 'A buy' })),
    '/instruments': page('Instruments', instrumentsContent({ instruments: data.instruments })),
    '/instruments/new (errors)': page('Add an instrument', instrumentForm({ action: '/instruments', csrf: 'token', values: {}, errors: { isin: 'Wrong.' } })),
    '/accounts': page('Accounts', accountsContent({ accounts: data.accounts })),
    '/accounts/new': page('Add an account', accountForm({ action: '/accounts', csrf: 'token', values: {} })),
    '(404)': notFound,
    '(message)': messagePage(render, { title: 'Something went wrong', text: 'Try again.', session }),
    '/login': loginPage(render),
    '/login (error)': loginPage(render, { error: 'Wrong username or password.', username: 'me' }),
    '/login/code': codePage(render, { csrf: 'token', error: 'That code didn\'t work.' }),
    '/login/setup': await setupPage(render, { csrf: 'token', secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', uri: 'otpauth://totp/Invest:me?secret=JBSWY3DPEHPK3PXP' }),
};

const main = html => html.match(/<main[^>]*>([\s\S]*)<\/main>/)[1];
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

// Text a screen reader would read: tags removed, aria-hidden parts dropped
function spoken(fragment) {
    return fragment
        .replace(/<(\w+)[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/\1>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&\w+;/g, ' ')
        .trim();
}

// [{ open, inner }] for each <name …>…</name> (not nested in itself)
const elements = (html, name) => [...html.matchAll(new RegExp(`(<${name}\\b[^>]*>)([\\s\\S]*?)</${name}>`, 'g'))]
    .map(([, open, inner]) => ({ open, inner }));

for (const [path, html] of Object.entries(all)) {
    test(`${path}: page language, title, skip link and one main heading`, () => {
        assert.match(html, /<html lang="en"/);
        assert.match(html, /<title>[^<]+<\/title>/);
        assert.match(html, /<a href="#app-content" class="skip-link">/);
        assert.equal((main(html).match(/<h1\b/g) ?? []).length, 1, 'exactly one <h1> in <main>');
    });

    test(`${path}: headings don't skip levels`, () => {
        const levels = [...main(html).matchAll(/<h([1-6])\b/g)].map(m => Number(m[1]));
        levels.forEach((level, i) => {
            if (i > 0) assert.ok(level <= levels[i - 1] + 1, `<h${level}> follows <h${levels[i - 1]}>`);
        });
    });

    test(`${path}: buttons and links have names`, () => {
        for (const name of ['button', 'a']) {
            for (const { open, inner } of elements(html, name)) {
                const label = attr(open, 'aria-label') || attr(open, 'title') || spoken(inner);
                assert.ok(label, `${open} has no text or aria-label`);
            }
        }
    });

    test(`${path}: icons are hidden from screen readers, images have alt text`, () => {
        for (const icon of html.match(/<i class="bi [^"]*"[^>]*>/g) ?? []) {
            assert.match(icon, /aria-hidden="true"/, `${icon} needs aria-hidden="true"`);
        }
        for (const img of html.match(/<img\b[^>]*>/g) ?? []) assert.match(img, /\salt="/, `${img} needs alt`);
    });

    test(`${path}: ids are unique, and the ids that labels and ARIA refer to exist`, () => {
        const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
        assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'duplicate ids');
        for (const [, ref] of html.matchAll(/\s(?:for|aria-controls|aria-describedby|aria-labelledby)="([^"]+)"/g)) {
            for (const id of ref.split(' ')) assert.ok(ids.includes(id), `nothing has id="${id}"`);
        }
    });

    test(`${path}: form fields have labels, and nothing forces its own tab order`, () => {
        for (const input of html.match(/<(input|select|textarea)\b[^>]*>/g) ?? []) {
            if (/type="(hidden|submit|button)"/.test(input)) continue;
            const id = attr(input, 'id');
            assert.ok(attr(input, 'aria-label') || (id && html.includes(`for="${id}"`)), `${input} has no label`);
        }
        assert.doesNotMatch(html, /tabindex="[1-9]/, 'positive tabindex');
    });
}

// ── Colours ─────────────────────────────────────────────────────────────────

function luminance(hex) {
    const full = hex.length === 4 ? `#${[...hex.slice(1)].map(c => c + c).join('')}` : hex;
    const [r, g, b] = [1, 3, 5].map(i => parseInt(full.slice(i, i + 2), 16) / 255)
        .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

// The surfaces text sits on: page and header
const SURFACES = ['#0f1117', '#161b27'];


test('every text colour in style.css meets WCAG AA (4.5:1) on every surface', () => {
    const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
    const colours = new Set([...css.matchAll(/(?<![-\w])color:\s*(#[0-9a-f]{3,6})\b/gi)].map(m => m[1].toLowerCase()));
    assert.ok(colours.size > 0);
    for (const colour of colours) {
        for (const surface of SURFACES) {
            const ratio = contrast(colour, surface);
            assert.ok(ratio >= 4.5, `${colour} on ${surface} is ${ratio.toFixed(2)}:1`);
        }
    }
});
