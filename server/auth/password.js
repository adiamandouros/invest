import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

// Passwords are hashed with scrypt (built into Node, so nothing to compile on
// the server), stored as scrypt$N$r$p$salt$hash so the cost can be raised
// later without breaking existing hashes.

const scryptAsync = promisify(scrypt);
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024; // N = 2^15 needs 32 MB, Node's default limit

const normalise = password => String(password).normalize('NFKC');

export async function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = await scryptAsync(normalise(password), salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEMORY });
    return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
    const [scheme, n, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64url');
    const actual = await scryptAsync(normalise(password), Buffer.from(salt, 'base64url'), expected.length,
        { N: Number(n), r: Number(r), p: Number(p), maxmem: MAX_MEMORY });
    return timingSafeEqual(actual, expected);
}

// The same work as a real check, for usernames that don't exist, so the
// response time doesn't tell which usernames do. Always false.
let dummyHash;
export async function verifyNoPassword(password) {
    dummyHash ??= hashPassword('no such user');
    await verifyPassword(password, await dummyHash);
    return false;
}
