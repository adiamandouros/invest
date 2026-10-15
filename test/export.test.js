import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backup, transactionsCsv } from '../server/lib/export.js';
import { location, signUp, start } from './helpers/app.js';
import { fixture } from './helpers/portfolio.js';

test('the backup has every table but nothing from sign-in', async () => {
    const data = await fixture();
    const b = await backup(data, new Date('2026-10-16T12:00:00Z'));
    assert.deepEqual(Object.keys(b), ['app', 'format', 'exportedAt', 'accounts', 'instruments', 'transactions', 'p2pBalances', 'allocationGroups', 'prices', 'fxRates']);
    assert.equal(b.exportedAt, '2026-10-16T12:00:00.000Z');
    assert.equal(b.accounts.length, 3);
    assert.equal(b.transactions.length, data.transactions.length);
    assert.equal(b.allocationGroups.length, 2);
    assert.equal(b.prices.length, 2);
    assert.doesNotMatch(JSON.stringify(b), /password|totp|session/i);
});

test('the transactions as CSV, with names instead of ids', async () => {
    const csv = (await transactionsCsv(await fixture())).split('\r\n');
    assert.equal(csv[0], 'Date,Account,Type,Symbol,ISIN,Units,Price,Amount,Currency,Fee,Fee currency,EUR rate,Notes,Statement reference');
    assert.ok(csv.includes('2024-03-01,Broker,buy,ETF,,10,10,-100,EUR,1,,1,,'));
    assert.ok(csv.some(line => /^2024-05-31,PeerBerry,interest,,,,,0\.8,EUR,0,,1,"PeerBerry interest for 2024-05, the sum of 1 statement row: Repayment interest",peerberry:EUR:2024-05:interest$/.test(line)), 'notes with a comma are quoted');
});

test('the export page and its downloads need a session', async () => {
    const app = await start({ data: await fixture() });
    app.clock.now = Date.parse('2026-10-16T12:00:00Z');
    try {
        const b = app.browser();
        for (const path of ['/export', '/export/backup.json', '/export/transactions.csv']) assert.equal(location(await b.get(path)), '/login', path);
        await signUp(b, app.clock);
        assert.match(await (await b.get('/settings')).text(), /href="\/export">Export your data<\/a>/);
        assert.match(await (await b.get('/export')).text(), /Right now: 3 accounts, \d+ transactions, 2 prices/);

        const json = await b.get('/export/backup.json');
        assert.match(json.headers.get('content-type'), /^application\/json/);
        assert.match(json.headers.get('content-disposition'), /attachment; filename="invest-backup-2026-10-16\.json"/);
        assert.equal((await json.json()).app, 'invest');

        const csv = await b.get('/export/transactions.csv');
        assert.match(csv.headers.get('content-disposition'), /invest-transactions-2026-10-16\.csv/);
        assert.match(await csv.text(), /^Date,Account,Type/);
    } finally {
        app.close();
    }
});
