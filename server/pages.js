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
function fill(template, values) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

export const view = name => readFileSync(join(VIEWS_DIR, `${name}.html`), 'utf8');

// Every page, wrapped in the shared layout
export function createRenderer() {
    const layout = view('layout')
        .replace(/(href|src)="(\/[^"]+)"/g, (_, name, url) => `${name}="${versioned(url)}"`);
    return ({ title, content, scripts = [] }) => fill(layout, {
        title: escapeHtml(`${title} — Invest`),
        content,
        scripts: scripts.map(src => `    <script type="module" src="${versioned(src)}"></script>`).join('\n'),
    });
}

// The fixed pages, by path (also used by test/accessibility.test.js)
export function renderPages(render = createRenderer()) {
    return {
        pages: {
            '/': render({ title: 'Overview', content: view('home') }),
        },
        notFound: render({ title: 'Page not found', content: view('notfound') }),
    };
}
