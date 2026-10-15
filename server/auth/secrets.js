import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

// Encrypts secrets stored in the database (the authenticator secret) with
// ENCRYPTION_KEY, so a copy of the database alone can't produce sign-in
// codes. AES-256-GCM also detects any change to the stored text.
// Format: v1.<iv>.<tag>.<ciphertext>, each part base64url.

const keyFrom = secret => createHash('sha256').update(String(secret)).digest();

export function seal(text, secret) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return ['v1', ...[iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url'))].join('.');
}

// Throws if the text was changed or ENCRYPTION_KEY isn't the one it was sealed with
export function unseal(sealed, secret) {
    const [version, iv, tag, encrypted] = String(sealed).split('.');
    if (version !== 'v1' || !encrypted) throw new Error('Not a sealed secret');
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}
