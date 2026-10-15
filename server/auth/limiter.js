// Count failed sign-in attempts per client and block after `max` within
// `windowMs` (the same limiter as Move's admin)
export function createLimiter({ max = 5, windowMs = 15 * 60_000, now = Date.now } = {}) {
    const failures = new Map();
    const recent = key => (failures.get(key) ?? []).filter(t => now() - t < windowMs);

    return {
        blocked: key => recent(key).length >= max,
        fail(key) {
            failures.set(key, [...recent(key), now()]);
            // Forget old clients so the map can't grow without bound
            if (failures.size > 1000) for (const k of failures.keys()) if (!recent(k).length) failures.delete(k);
        },
        reset: key => failures.delete(key),
    };
}
