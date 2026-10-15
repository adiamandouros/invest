// An in-memory stand-in for server/auth/store.js, with the same behaviour,
// so the sign-in flow can be tested without MySQL. Change both together.
export function createMemoryStore({ now = Date.now } = {}) {
    const users = new Map();
    const sessions = new Map();
    let nextId = 1;
    const later = seconds => now() + seconds * 1000;
    const toUser = u => u ? {
        id: u.id,
        username: u.username,
        passwordHash: u.passwordHash,
        totpSecret: u.totpSecret,
        locked: u.lockedUntil > now(),
    } : null;
    const signOutEverywhere = id => { for (const [k, s] of sessions) if (s.userId === id) sessions.delete(k); };

    return {
        users,
        sessions,

        findUserByName: async name => toUser([...users.values()].find(u => u.username.toLowerCase() === String(name).toLowerCase())),
        findUserById: async id => toUser(users.get(id)),

        async recordFailedLogin(id, max, lockSeconds) {
            const u = users.get(id);
            if (u.failedLogins + 1 >= max) {
                u.lockedUntil = later(lockSeconds);
                u.failedLogins = 0;
            } else {
                u.failedLogins++;
            }
        },
        async clearFailedLogins(id) {
            Object.assign(users.get(id), { failedLogins: 0, lockedUntil: 0 });
        },

        async useTotpStep(id, step) {
            const u = users.get(id);
            if (!u.totpSecret || (u.totpLastStep !== null && u.totpLastStep >= step)) return false;
            u.totpLastStep = step;
            return true;
        },
        async enableTotp(id, sealedSecret, step) {
            const u = users.get(id);
            if (u.totpSecret) return false;
            Object.assign(u, { totpSecret: sealedSecret, totpLastStep: step });
            return true;
        },

        async createSession({ tokenHash, userId, stage, csrf, seconds }) {
            sessions.set(tokenHash, { tokenHash, userId, stage, csrf, pendingTotp: null, expiresAt: later(seconds) });
        },
        async findSession(tokenHash) {
            const s = sessions.get(tokenHash);
            if (!s || s.expiresAt <= now()) return null;
            const { expiresAt, ...session } = s;
            return { ...session, username: users.get(s.userId).username };
        },
        countSessions: async userId => [...sessions.values()].filter(s => s.userId === userId && s.stage === 'full' && s.expiresAt > now()).length,
        async deleteOtherSessions(userId, keepTokenHash) {
            let n = 0;
            for (const [k, s] of sessions) if (s.userId === userId && k !== keepTokenHash) { sessions.delete(k); n++; }
            return n;
        },
        async setPendingTotp(tokenHash, sealedSecret) {
            sessions.get(tokenHash).pendingTotp = sealedSecret;
        },
        deleteSession: async tokenHash => { sessions.delete(tokenHash); },
        deleteExpiredSessions: async () => { for (const [k, s] of sessions) if (s.expiresAt <= now()) sessions.delete(k); },

        async createUser(username, passwordHash) {
            const id = nextId++;
            users.set(id, { id, username, passwordHash, totpSecret: null, totpLastStep: null, failedLogins: 0, lockedUntil: 0 });
            return { insertId: id };
        },
        async setPassword(id, passwordHash) {
            Object.assign(users.get(id), { passwordHash, failedLogins: 0, lockedUntil: 0 });
            signOutEverywhere(id);
        },
        async replaceTotp(id, sealedSecret, step) {
            Object.assign(users.get(id), { totpSecret: sealedSecret, totpLastStep: step });
        },
        async resetTotp(id) {
            Object.assign(users.get(id), { totpSecret: null, totpLastStep: null });
            signOutEverywhere(id);
        },
    };
}
