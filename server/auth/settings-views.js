import { escapeHtml as esc } from '../pages.js';
import { groupedKey, qrCode } from './views.js';

// The settings pages: change the password, move to a new authenticator app,
// sign out other devices (also rendered by test/accessibility.test.js).
// `errors` maps a field's name to a message.

const DONE = {
    password: 'Your password is changed. Other devices are signed out.',
    authenticator: 'Your new authenticator app is set up. Codes from the old one no longer work, and other devices are signed out.',
    'signed-out': 'Other devices are signed out.',
};

function input(name, label, errors, { type = 'password', autocomplete, hint = '', attrs = '' }) {
    const id = `f-${name}`;
    const error = errors[name];
    const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');
    return `    <div class="mb-3">
        <label for="${id}" class="form-label">${label}</label>
        <input id="${id}" name="${name}" type="${type}" class="form-control${error ? ' is-invalid' : ''}" autocomplete="${autocomplete}" required${described ? ` aria-describedby="${described}"` : ''}${error ? ' aria-invalid="true"' : ''} ${attrs}>
        ${hint ? `<div id="${id}-hint" class="form-text">${hint}</div>` : ''}
        ${error ? `<div id="${id}-error" class="invalid-feedback d-block">${esc(error)}</div>` : ''}
    </div>`;
}

const codeAttrs = 'inputmode="numeric" pattern="[0-9 ]*" maxlength="7"';

// `form`: which form the errors belong to ('password' or 'authenticator'); `sessions`: signed-in devices
export function settingsContent({ csrf, username, sessions, done = '', form = '', errors = {} }) {
    const pw = form === 'password' ? errors : {};
    const auth = form === 'authenticator' ? errors : {};
    return `<h1 class="fs-3">Settings</h1>
${DONE[done] ? `<div class="alert alert-success" role="status">${DONE[done]}</div>` : ''}
<p>Signed in as <strong>${esc(username)}</strong>.</p>

<h2 class="fs-5 mt-4" id="password-heading">Change your password</h2>
<form method="post" action="/settings/password" class="edit-form" novalidate aria-labelledby="password-heading">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
${input('current', 'Current password', pw, { autocomplete: 'current-password' })}
${input('password', 'New password', pw, { autocomplete: 'new-password', hint: 'At least 12 characters. A few unrelated words make a good one.' })}
${input('repeat', 'New password again', pw, { autocomplete: 'new-password' })}
    <button type="submit" class="btn btn-primary">Change password</button>
</form>

<h2 class="fs-5 mt-4" id="authenticator-heading">Move to a new authenticator app</h2>
<p>For a new phone or another app. You'll scan a new QR code; until you enter a code from the new app, the old one keeps working.</p>
<form method="post" action="/settings/authenticator" class="edit-form" novalidate aria-labelledby="authenticator-heading">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
${input('authCurrent', 'Current password', auth, { autocomplete: 'current-password' })}
${input('code', 'Code from your current app', auth, { type: 'text', autocomplete: 'one-time-code', attrs: codeAttrs, hint: 'If you no longer have it, an administrator can turn the code off with <code>npm run create-user -- --reset-2fa</code> on the server.' })}
    <button type="submit" class="btn btn-primary">Continue</button>
</form>

<h2 class="fs-5 mt-4" id="devices-heading">Signed-in devices</h2>
${sessions > 1 ? `<p>You're signed in on ${sessions} devices or browsers, this one included. Each stays signed in for up to two weeks.</p>
<form method="post" action="/settings/sessions">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <button type="submit" class="btn btn-outline-danger">Sign out everywhere else</button>
</form>` : '<p>You\'re only signed in here.</p>'}`;
}

// The new secret's QR code and key, and the field for a code from the new app
export async function newAuthenticatorContent({ csrf, secret, uri, error = '' }) {
    return `<h1 class="fs-3">Set up the new authenticator app</h1>
<ol>
    <li>In the new app, add an account and scan this QR code.</li>
    <li>Or, if you can't scan it, type in this key:<br><code class="totp-key">${esc(groupedKey(secret))}</code></li>
    <li>Enter the 6-digit code the new app shows.</li>
</ol>
<div class="qr-code mb-4">${await qrCode(uri)}</div>
${error ? `<div class="alert alert-danger" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="/settings/authenticator/confirm" class="edit-form">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="mb-4">
        <label for="code" class="form-label">Code from the new app</label>
        <input id="code" name="code" class="form-control code-input" ${codeAttrs} autocomplete="one-time-code" required>
    </div>
    <button type="submit" class="btn btn-primary">Switch to the new app</button>
</form>
<form method="post" action="/settings/authenticator/cancel" class="mt-3">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <button type="submit" class="btn btn-link px-0">Cancel and keep the old app</button>
</form>`;
}
