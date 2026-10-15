import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { assetVersion, escapeHtml, renderPages } from '../server/pages.js';

let server;
let base;
const get = path => fetch(base + path);

before(async () => {
    await new Promise(resolve => { server = createApp().listen(0, resolve); });
    base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('pages are sent with security headers and kept out of search engines', async () => {
    const res = await get('/login');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    // no-referrer would make browsers send "Origin: null" and break every form
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('/health says when the database isn\'t configured', async () => {
    const res = await get('/health');
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: 'degraded', db: 'not configured' });
});

test('/health reports a database that answers, and one that doesn\'t', async () => {
    for (const [db, status, body] of [
        [{ query: async () => [[{ 1: 1 }]] }, 200, { status: 'ok', db: 'ok' }],
        [{ query: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); } }, 503, { status: 'degraded', db: 'unreachable' }],
    ]) {
        const app = createApp({ db });
        const s = await new Promise(resolve => { const srv = app.listen(0, () => resolve(srv)); });
        const errors = console.error;
        console.error = () => {};
        try {
            const res = await fetch(`http://localhost:${s.address().port}/health`);
            assert.equal(res.status, status);
            assert.deepEqual(await res.json(), body);
        } finally {
            console.error = errors;
            s.close();
        }
    }
});

test('every linked stylesheet, script and icon is versioned and served', async () => {
    const html = await (await get('/login')).text();
    const links = [...html.matchAll(/(?:href|src)="(\/[^"#]+)"/g)].map(m => m[1]).filter(url => url !== '/');
    assert.ok(links.length >= 4);
    for (const url of links) {
        if (/\.(css|js)(\?|$)/.test(url)) assert.ok(url.endsWith(`?v=${assetVersion()}`), `${url} isn't versioned`);
        assert.equal((await get(url)).status, 200, url);
    }
});

test('robots.txt disallows everything', async () => {
    assert.match(await (await get('/robots.txt')).text(), /Disallow: \/$/m);
});

test('escapeHtml escapes markup and quotes', () => {
    assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    assert.equal(escapeHtml(null), '');
});

test('page titles name the page and the app', () => {
    const { pages, notFound } = renderPages();
    assert.match(pages['/'], /<title>Overview — Invest<\/title>/);
    assert.match(notFound, /<title>Page not found — Invest<\/title>/);
});

test('the sign-out button shows only for a signed-in session', () => {
    assert.doesNotMatch(renderPages().pages['/'], /Sign out/);
    assert.doesNotMatch(renderPages(undefined, { stage: 'password', csrf: 't' }).pages['/'], /Sign out/);
    const page = renderPages(undefined, { stage: 'full', csrf: 'a"b' }).pages['/'];
    assert.match(page, /action="\/logout"/);
    assert.match(page, /name="_csrf" value="a&quot;b"/);
});
