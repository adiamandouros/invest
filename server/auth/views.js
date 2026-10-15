import QRCode from 'qrcode';
import { escapeHtml, fill, view } from '../pages.js';

// The sign-in pages (also rendered by test/accessibility.test.js)

const alert = error => error ? `<div class="alert alert-danger" role="alert">${escapeHtml(error)}</div>` : '';

export const loginPage = (render, { error = '', username = '' } = {}) => render({
    title: 'Sign in',
    content: fill(view('login'), { error: alert(error), username: escapeHtml(username) }),
});

export const codePage = (render, { csrf, error = '' }) => render({
    title: 'Authenticator code',
    content: fill(view('login-code'), { error: alert(error), csrf: escapeHtml(csrf) }),
});

export async function setupPage(render, { csrf, secret, uri, error = '' }) {
    const svg = await QRCode.toString(uri, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    return render({
        title: 'Set up your authenticator app',
        content: fill(view('login-setup'), {
            error: alert(error),
            csrf: escapeHtml(csrf),
            qr: svg.replace('<svg ', '<svg role="img" aria-label="QR code for your authenticator app" '),
            // In groups of four, easier to type in by hand
            secret: secret.match(/.{1,4}/g).join(' '),
        }),
    });
}
