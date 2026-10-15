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
        assert.match(previewHtml, /Everything matches the report/);
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
        assert.match(await bad.text(), /Only Freedom24 broker reports/);
        assert.equal((await b.post('/import/confirm', { _csrf: csrf, id: 'nope' })).status, 410);
    } finally {
        app.close();
    }
});
