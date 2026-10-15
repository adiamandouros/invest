import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// Authenticator-app codes (TOTP, RFC 6238): HMAC-SHA1, 6 digits, 30 seconds,
// the settings every authenticator app supports. Secrets are base32 text.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;

export function base32Encode(bytes) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = ((value << 8) | byte) & 0xfff;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

export function base32Decode(text) {
    let bits = 0;
    let value = 0;
    const out = [];
    for (const char of String(text).replace(/[\s=]/g, '').toUpperCase()) {
        const index = ALPHABET.indexOf(char);
        if (index < 0) throw new Error('The secret isn\'t base32');
        value = ((value << 5) | index) & 0xfff;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

// 160 random bits, the size RFC 4226 recommends
export const generateSecret = () => base32Encode(randomBytes(20));

export const stepAt = nowMs => Math.floor(nowMs / 1000 / PERIOD);

export function codeAt(secret, step) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
    const offset = hmac[hmac.length - 1] & 15;
    const number = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
    return String(number).padStart(DIGITS, '0');
}

// The time step `code` belongs to, allowing one step either side for a phone
// clock that's a little off, or null if it doesn't match
export function verifyCode(secret, code, nowMs = Date.now()) {
    const attempt = String(code ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(attempt)) return null;
    const current = stepAt(nowMs);
    for (let step = current - 1; step <= current + 1; step++) {
        if (timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(attempt))) return step;
    }
    return null;
}

// What the QR code holds, for authenticator apps to add the account
export function otpauthUri(secret, account, issuer = 'Invest') {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}
