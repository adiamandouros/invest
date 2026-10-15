import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { csrfOf, location, signUp, start } from './helpers/app.js';

const REPORT = readFileSync(new URL('./fixtures/freedom24-report.json', import.meta.url), 'utf8');

function upload(csrf, text = REPORT) {
    const form = new FormData();
    form.append('_csrf', csrf);
    form.append('statement', new Blob([text], { type: 'application/json' }), 'report.json');
    return form;
}

test('the portfolio pages need a session', async () => {
    const app = await start();
    try {
        for (const path of ['/holdings', '/transactions', '/import']) {
            assert.equal(location(await app.browser().get(path)), '/login', path);
        }
    } finally {
        app.close();
    }
});

test('importing a report: preview, then import, then holdings and transactions', async () => {
    const app = await start();
    try {
        const b = app.browser();
        await signUp(b, app.clock);
        assert.match(await (await b.get('/holdings')).text(), /Nothing recorded yet/);

        const form = await (await b.get('/import')).text();
        assert.match(form, /aria-current="page"[^>]*>Import|href="\/import" aria-current="page"/);
        const preview = await b.post('/import/preview', upload(csrfOf(form)));
        assert.equal(preview.status, 200);
        const previewHtml = await preview.text();
        assert.match(previewHtml, /Freedom24 \(new\)/);
        assert.match(previewHtml, /Everything matches the statement/);
        assert.equal(app.data.transactions.length, 0, 'nothing saved by the preview');

        const id = previewHtml.match(/name="id" value="([^"]+)"/)[1];
        const done = await b.post('/import/confirm', { _csrf: csrfOf(previewHtml), id });
        assert.match(await done.text(), /Added 18 transactions to Freedom24/);
        assert.equal(app.data.transactions.length, 18);

        const again = await b.post('/import/confirm', { _csrf: csrfOf(previewHtml), id });
        assert.equal(again.status, 410, 'a preview imports once');

        const holdings = await (await b.get('/holdings')).text();
        assert.match(holdings, /VUAA\.EU/);
        assert.match(holdings, /€433\.33/, 'VUAA cost in EUR');
        assert.match(holdings, /\+€104\.94/, 'VUAA realised gain');
        assert.match(holdings, /Closed positions/);
        assert.match(holdings, /−€0\.51/, 'OCGN loss with a real minus sign');
        assert.match(holdings, /\$392\.23/, 'USD cash');

        const vuaa = app.data.instruments.find(i => i.symbol === 'VUAA.EU');
        const list = await (await b.get(`/transactions?instrument=${vuaa.id}`)).text();
        assert.match(list, /Transactions: VUAA\.EU/);
        assert.match(list, /2 transactions, newest first/);
        assert.match(await (await b.get('/transactions')).text(), /18 transactions/);

        const nothingNew = await (await b.post('/import/preview', upload(csrfOf(holdings)))).text();
        assert.match(nothingNew, /nothing new to import/);
    } finally {
        app.close();
    }
});

test('uploads need the form token and a readable report', async () => {
    const app = await start();
    try {
        const b = app.browser();
        await signUp(b, app.clock);
        const csrf = csrfOf(await (await b.get('/import')).text());
        assert.equal((await b.post('/import/preview', upload('wrong'))).status, 403);
        const bad = await b.post('/import/preview', upload(csrf, '{"not": "a report"}'));
        assert.equal(bad.status, 400);
        assert.match(await bad.text(), /Mintos account statements \(CSV\) or PeerBerry transactions \(Excel\)/);
        assert.equal((await b.post('/import/confirm', { _csrf: csrf, id: 'nope' })).status, 410);
    } finally {
        app.close();
    }
});

test('adding, editing and deleting a transaction, with errors shown on the form', async () => {
    const app = await start();
    try {
        const b = app.browser();
        await signUp(b, app.clock);
        assert.equal(location(await b.get('/transactions/new')), '/accounts/new', 'an account comes first');

        let html = await (await b.get('/accounts/new')).text();
        assert.equal(location(await b.post('/accounts', { _csrf: csrfOf(html), name: 'Mintos', kind: 'p2p', platform: 'mintos', baseCurrency: 'EUR' })), '/accounts');
        html = await (await b.get('/instruments/new')).text();
        assert.equal(location(await b.post('/instruments', {
            _csrf: csrfOf(html), symbol: 'VUAA.DE', name: 'Vanguard S&P 500', isin: 'IE00BFMXXD54', kind: 'etf', currency: 'EUR', distributing: 'no',
        })), '/instruments');
        const duplicate = await b.post('/instruments', { _csrf: csrfOf(html), symbol: 'X', name: 'X', isin: 'IE00BFMXXD54', kind: 'etf', currency: 'EUR' });
        assert.equal(duplicate.status, 400);
        assert.match(await duplicate.text(), /Another instrument already has this ISIN/);

        html = await (await b.get('/transactions/new')).text();
        const csrf = csrfOf(html);
        const bad = await b.post('/transactions', { _csrf: csrf, type: 'buy', date: '2026-10-15', account: '1', instrument: '1', units: 'two', price: '100', currency: 'EUR' });
        assert.equal(bad.status, 400);
        const badHtml = await bad.text();
        assert.match(badHtml, /role="alert"[\s\S]*href="#f-units"/, 'an error summary linking to the field');
        assert.match(badHtml, /id="f-units"[^>]*aria-describedby="f-units-hint f-units-error"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*id="f-units"/);
        assert.match(badHtml, /value="two"/, 'what was typed is kept');

        const added = await b.post('/transactions', { _csrf: csrf, type: 'buy', date: '2026-10-15', account: '1', instrument: '1', units: '2', price: '100', fee: '1', currency: 'EUR' });
        assert.equal(location(added), '/transactions?instrument=1');
        const [t] = app.data.transactions;
        assert.deepEqual([t.amount, t.fee, t.fxToEur], ['-200', '1', '1']);
        assert.match(await (await b.get('/holdings')).text(), /€201\.00/, 'cost with the fee');

        const edit = await (await b.get(`/transactions/${t.id}/edit`)).text();
        assert.match(edit, /id="f-amount"[^>]*value="200"|value="200"[^>]*id="f-amount"/);
        await b.post(`/transactions/${t.id}`, { _csrf: csrf, type: 'buy', date: '2026-10-14', account: '1', instrument: '1', units: '3', price: '100', currency: 'EUR' });
        assert.deepEqual([app.data.transactions[0].units, app.data.transactions[0].date], ['3', '2026-10-14']);

        assert.match(await (await b.get(`/transactions/${t.id}/delete`)).text(), /Delete this transaction\?/);
        assert.equal((await b.post(`/transactions/${t.id}/delete`, {})).status, 403, 'needs the token');
        assert.equal(location(await b.post(`/transactions/${t.id}/delete`, { _csrf: csrf })), '/transactions?instrument=1');
        assert.equal(app.data.transactions.length, 0);
        assert.equal((await b.get(`/transactions/${t.id}/edit`)).status, 404);

        await b.post('/instruments/1', { _csrf: csrf, symbol: 'VUAA.DE', name: 'Renamed', isin: 'IE00BFMXXD54', kind: 'etf', currency: 'EUR', distributing: 'yes' });
        assert.deepEqual([app.data.instruments[0].name, app.data.instruments[0].distributing], ['Renamed', true]);
        assert.match(await (await b.get('/instruments')).text(), /Distributing/);
        await b.post('/accounts/1', { _csrf: csrf, name: 'Mintos EUR', kind: 'p2p', platform: 'mintos', baseCurrency: 'EUR' });
        assert.match(await (await b.get('/accounts')).text(), /Mintos EUR/);
    } finally {
        app.close();
    }
});

test('holdings show value, gain and return, and "Update now" runs an update', async () => {
    let runs = 0;
    const market = {
        running: false,
        refreshIfStale: async () => false,
        run: async () => {
            runs++;
            const id = symbol => app.data.instruments.find(i => i.symbol === symbol).id;
            await app.data.savePrices([
                { instrumentId: id('VUAA.EU'), date: '2023-11-14', close: '149.5', currency: 'USD', source: 'yahoo' },
                { instrumentId: id('VTI.US'), date: '2023-11-14', close: '377', currency: 'USD', source: 'yahoo' },
            ]);
        },
    };
    const app = await start({ market });
    try {
        const b = app.browser();
        await signUp(b, app.clock);
        const form = await (await b.get('/import')).text();
        const preview = await (await b.post('/import/preview', upload(csrfOf(form)))).text();
        await b.post('/import/confirm', { _csrf: csrfOf(preview), id: preview.match(/name="id" value="([^"]+)"/)[1] });
        await app.data.saveFxRates([{ currency: 'USD', date: '2022-01-03', perEur: '1.13' }]);

        let html = await (await b.get('/holdings')).text();
        assert.match(html, /No prices yet/);
        assert.match(html, /No price yet for .*VUAA\.EU.*, so the totals can't be worked out/);
        assert.match(html, /No price yet for .*VTI\.US.*, so the totals can't be worked out/);
        assert.match(html, /Return a year<\/dt><dd>—/, 'unknown, not a guess');

        assert.equal(location(await b.post('/prices/update', { _csrf: csrfOf(html) })), '/holdings');
        assert.equal(runs, 1);
        html = await (await b.get('/holdings')).text();
        assert.match(html, /Prices as of 2023-11-14 from Yahoo Finance/);
        // 6 × 149.5 USD at 1.13 = 793.81 EUR
        assert.match(html, /€793\.81/);
        assert.match(html, /Value now/);
        assert.match(html, /Return a year<\/dt><dd>[+−]\d+\.\d%/);
        assert.equal((await b.post('/prices/update', {})).status, 403, 'needs the token');
    } finally {
        app.close();
    }
});
