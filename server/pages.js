import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const ROOT       = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS_DIR  = join(ROOT, 'server', 'views');
export const PUBLIC_DIR = join(ROOT, 'public');

const require = createRequire(import.meta.url);
const packageDir = name => dirname(require.resolve(`${name}/package.json`));

// Third-party files served from node_modules, so nothing loads from a CDN
export const VENDOR = {
    '/vendor/bootstrap':       join(packageDir('bootstrap'), 'dist'),
    '/vendor/bootstrap-icons': join(packageDir('bootstrap-icons'), 'font'),
    // chart.js doesn't export its package.json; its main file is in dist/
    '/vendor/chart.js':        dirname(require.resolve('chart.js')),
};

// ── Asset versions ──────────────────────────────────────────────────────────

// Stylesheets and scripts are linked as <url>?v=<hash of every asset file>, so
// each deploy gives them new URLs: the live server's LiteSpeed serves public/
// with a 7-day cache, which would otherwise mix old files with new pages.
let version = null;
export function assetVersion() {
    if (version) return version;
    const hash = createHash('sha256');
    for (const file of listFiles(PUBLIC_DIR)) hash.update(readFileSync(file));
    for (const dir of Object.values(VENDOR)) hash.update(readFileSync(join(dir, '..', 'package.json')));
    version = hash.digest('hex').slice(0, 10);
    return version;
}

const VERSIONED = /^\/(css|js|vendor)\/.+\.(css|js)$/;
export const versioned = url => VERSIONED.test(url) ? `${url}?v=${assetVersion()}` : url;

export function listFiles(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap(name => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? listFiles(path) : [path];
    });
}

export const urlPath = (base, dir, file) => `${base}/${relative(dir, file).split(sep).join('/')}`;

// ── Rendering ───────────────────────────────────────────────────────────────

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ESCAPES[c]);

// {{name}} is replaced as is; callers escape anything that came from a user
export function fill(template, values) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

export const view = name => readFileSync(join(VIEWS_DIR, `${name}.html`), 'utf8');

// The signed-in part of the header: page links and the sign-out button
const NAV = [
    ['/', 'Overview'], ['/holdings', 'Holdings'], ['/p2p', 'P2P'], ['/allocation', 'Allocation'], ['/reports', 'Reports'], ['/transactions', 'Transactions'],
    ['/instruments', 'Instruments'], ['/accounts', 'Accounts'], ['/import', 'Import'],
];

function navigation(session, path) {
    if (session?.stage !== 'full') return '';
    const links = NAV.map(([href, label]) =>
        `<li class="nav-item"><a class="nav-link" href="${href}"${href === path ? ' aria-current="page"' : ''}>${label}</a></li>`).join('');
    return `            <ul class="nav">${links}</ul>
            <form method="post" action="/logout" class="ms-auto">
                <input type="hidden" name="_csrf" value="${escapeHtml(session.csrf)}">
                <button type="submit" class="btn btn-outline-primary btn-sm">
                    <i class="bi bi-box-arrow-right me-1" aria-hidden="true"></i>Sign out
                </button>
            </form>`;
}

// Every page, wrapped in the shared layout. `session` is req.session, `path`
// the page's path (to mark it in the navigation).
export function createRenderer() {
    const layout = view('layout')
        .replace(/(href|src)="(\/[^"]+)"/g, (_, name, url) => `${name}="${versioned(url)}"`);
    return ({ title, content, scripts = [], session = null, path = null }) => fill(layout, {
        title: escapeHtml(`${title} — Invest`),
        content,
        navigation: navigation(session, path),
        scripts: scripts.map(src => `    <script type="module" src="${versioned(src)}"></script>`).join('\n'),
    });
}

// The fixed pages, by path, for signed-in users
export const PAGES = {
    '/': { title: 'Overview', view: 'home' },
};

// A short page with a heading and one sentence (errors, refusals)
export const messagePage = (render, { title, text, session = null }) => render({
    title,
    content: fill(view('message'), { title: escapeHtml(title), text: escapeHtml(text) }),
    session,
});

// Every fixed page as `session` would see it (used by test/accessibility.test.js)
export function renderPages(render = createRenderer(), session = null) {
    return {
        pages: Object.fromEntries(Object.entries(PAGES)
            .map(([path, page]) => [path, render({ title: page.title, content: view(page.view), session, path })])),
        notFound: render({ title: 'Page not found', content: view('notfound'), session }),
    };
}
