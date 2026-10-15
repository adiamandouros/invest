// The SQL behind sign-in, on a mysql2 pool. test/helpers/memory-store.js
// mirrors this interface for the tests, so change both together.
//
// Times are compared in SQL with UTC_TIMESTAMP(), so neither the server's
// time zone nor the app's clock matters.

const USER = `SELECT id, username, password_hash, totp_secret,
                     locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP() AS locked
              FROM users`;

// Number(): with bigNumberStrings, MySQL's 0/1 for a comparison comes back as "0"/"1"
const toUser = row => row && {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret,
    locked: Number(row.locked) === 1,
};

export function createStore(db) {
    const one = async (sql, params) => (await db.query(sql, params))[0][0] ?? null;
    const run = async (sql, params) => (await db.query(sql, params))[0];
    const signOutEverywhere = id => run('DELETE FROM sessions WHERE user_id = ?', [id]);

    return {
        findUserByName: async username => toUser(await one(`${USER} WHERE username = ?`, [username])),
        findUserById: async id => toUser(await one(`${USER} WHERE id = ?`, [id])),

        // After `max` failures in a row, lock the user for `lockSeconds` and start counting again.
        // (MySQL applies SET assignments left to right, so locked_until reads the old count.)
        recordFailedLogin: (id, max, lockSeconds) => run(
            `UPDATE users
             SET locked_until = IF(failed_logins + 1 >= ?, UTC_TIMESTAMP() + INTERVAL ? SECOND, locked_until),
                 failed_logins = IF(failed_logins + 1 >= ?, 0, failed_logins + 1)
             WHERE id = ?`, [max, lockSeconds, max, id]),
        clearFailedLogins: id => run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [id]),

        // Accept a code's time step only if it's newer than the last one used: true if accepted
        useTotpStep: async (id, step) => (await run(
            `UPDATE users SET totp_last_step = ?
             WHERE id = ? AND totp_secret IS NOT NULL AND (totp_last_step IS NULL OR totp_last_step < ?)`,
            [step, id, step])).affectedRows === 1,
        // Save a confirmed authenticator secret, unless one is already set: true if saved
        enableTotp: async (id, sealedSecret, step) => (await run(
            'UPDATE users SET totp_secret = ?, totp_last_step = ? WHERE id = ? AND totp_secret IS NULL',
            [sealedSecret, step, id])).affectedRows === 1,

        createSession: ({ tokenHash, userId, stage, csrf, seconds }) => run(
            `INSERT INTO sessions (token_hash, user_id, stage, csrf_token, expires_at)
             VALUES (?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL ? SECOND)`,
            [tokenHash, userId, stage, csrf, seconds]),
        async findSession(tokenHash) {
            const row = await one(
                `SELECT s.token_hash, s.user_id, s.stage, s.csrf_token, s.pending_totp, u.username
                 FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()`, [tokenHash]);
            return row && {
                tokenHash: row.token_hash,
                userId: row.user_id,
                username: row.username,
                stage: row.stage,
                csrf: row.csrf_token,
                pendingTotp: row.pending_totp,
            };
        },
        // Signed-in sessions (both steps done) that haven't expired
        countSessions: async userId => Number((await one(
            `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND stage = 'full' AND expires_at > UTC_TIMESTAMP()`, [userId])).n),
        // Every session of the user but this one: the number deleted
        deleteOtherSessions: async (userId, keepTokenHash) => (await run(
            'DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [userId, keepTokenHash])).affectedRows,
        setPendingTotp: (tokenHash, sealedSecret) => run('UPDATE sessions SET pending_totp = ? WHERE token_hash = ?', [sealedSecret, tokenHash]),
        deleteSession: tokenHash => run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]),
        deleteExpiredSessions: () => run('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP()'),

        // For scripts/create-user.js
        createUser: (username, passwordHash) => run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, passwordHash]),
        async setPassword(id, passwordHash) {
            await run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', [passwordHash, id]);
            await signOutEverywhere(id);
        },
        // A new authenticator secret, confirmed with a code of the given step (from the settings page)
        replaceTotp: (id, sealedSecret, step) => run('UPDATE users SET totp_secret = ?, totp_last_step = ? WHERE id = ?', [sealedSecret, step, id]),
        async resetTotp(id) {
            await run('UPDATE users SET totp_secret = NULL, totp_last_step = NULL WHERE id = ?', [id]);
            await signOutEverywhere(id);
        },
    };
}
