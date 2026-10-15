import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../server/auth/limiter.js';
import { hashPassword, verifyNoPassword, verifyPassword } from '../server/auth/password.js';
import { seal, unseal } from '../server/auth/secrets.js';
import { base32Decode, base32Encode, codeAt, generateSecret, otpauthUri, stepAt, verifyCode } from '../server/auth/totp.js';

// RFC 6238, appendix B: the SHA-1 test secret, and its 8-digit codes cut to 6
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

test('base32 matches RFC 4648 and round-trips', () => {
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
    assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(base32Decode('mzxw 6ytb oi==').toString(), 'foobar');
    const secret = generateSecret();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.equal(base32Encode(base32Decode(secret)), secret);
    assert.throws(() => base32Decode('not base32!'), /isn't base32/);
});

test('codes match the RFC 6238 test values', () => {
    for (const [seconds, code] of [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']]) {
        assert.equal(codeAt(RFC_SECRET, stepAt(seconds * 1000)), code, `at ${seconds}`);
    }
});

test('a code is accepted one step either side of now, and nothing else is', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    assert.equal(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step), now), step);
    assert.equal(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step - 1), now), step - 1);
    assert.equal(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step + 1), now), step + 1);
    assert.equal(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step - 2), now), null);
    const code = codeAt(RFC_SECRET, step);
    assert.equal(verifyCode(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now), step, 'spaces are ignored');
    for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined]) assert.equal(verifyCode(RFC_SECRET, bad, now), null);
});

test('the QR code\'s URI names the app and the account', () => {
    assert.equal(otpauthUri('ABC', 'me@x'),
        'otpauth://totp/Invest%3Ame%40x?secret=ABC&issuer=Invest&algorithm=SHA1&digits=6&period=30');
});

test('passwords are hashed with a salt and checked', async () => {
    const hash = await hashPassword('correct horse battery');
    assert.match(hash, /^scrypt\$32768\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
    assert.notEqual(await hashPassword('correct horse battery'), hash, 'a new salt each time');
    assert.equal(await verifyPassword('correct horse battery', hash), true);
    assert.equal(await verifyPassword('correct horse batter', hash), false);
    assert.equal(await verifyPassword('anything', 'not a hash'), false);
    assert.equal(await verifyNoPassword('anything'), false);
});

test('sealed secrets need the same key, and changes are detected', () => {
    const key = 'k'.repeat(32);
    const sealed = seal('JBSWY3DPEHPK3PXP', key);
    assert.match(sealed, /^v1\./);
    assert.notEqual(seal('JBSWY3DPEHPK3PXP', key), sealed, 'a new IV each time');
    assert.equal(unseal(sealed, key), 'JBSWY3DPEHPK3PXP');
    assert.throws(() => unseal(sealed, 'x'.repeat(32)));
    const parts = sealed.split('.');
    parts[3] = parts[3].replace(/^./, c => c === 'A' ? 'B' : 'A');
    assert.throws(() => unseal(parts.join('.'), key));
    assert.throws(() => unseal('plain text', key), /Not a sealed secret/);
});

test('the limiter blocks after the maximum, then forgets', () => {
    let clock = 0;
    const limiter = createLimiter({ max: 2, windowMs: 1000, now: () => clock });
    limiter.fail('a');
    assert.equal(limiter.blocked('a'), false);
    limiter.fail('a');
    assert.equal(limiter.blocked('a'), true);
    assert.equal(limiter.blocked('b'), false);
    clock = 1000;
    assert.equal(limiter.blocked('a'), false);
});
