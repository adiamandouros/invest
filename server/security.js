// Response headers for every page Express sends. (On the live server LiteSpeed
// serves public/ itself, so these don't reach those static files; they hold
// nothing private.)

const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(req, res, next) {
    res.set({
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        // Not no-referrer: with that, browsers send "Origin: null" on form posts,
        // and the same-site check in server/auth/index.js refuses every sign-in
        'Referrer-Policy': 'same-origin',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
        // A private site: keep it out of search engines
        'X-Robots-Tag': 'noindex, nofollow',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
}
