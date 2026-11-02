// Usage endpoint budget. The endpoint admits ~28-30 requests per
// trailing 60 minutes per account; we aim for <= 20/h.

export const ACTIVE_DEFAULT_S = 180;
export const ACTIVE_MIN_S = 120;
export const INACTIVE_S = 1800;
export const NETWORK_ERROR_S = 300;
export const RATE_LIMIT_MARGIN_S = 900;
export const RATE_LIMIT_DEFAULT_S = 3600;
/** --force still keeps this spacing so a refresh-mashing user can't burn the budget. */
export const FORCE_MIN_S = 60;
/** Hard cap of attempts in any trailing hour, even with --force (server cap ~28-30). */
export const HARD_CAP_PER_HOUR = 25;
const HOUR_MS = 3600e3;

/** Attempts of the trailing hour (ISO strings), pruned. */
export function recentAttempts(entry, nowMs) {
    return (entry?.recent ?? []).filter(t => nowMs - Date.parse(t) < HOUR_MS);
}

/** New cache entry fields after an attempt at nowMs. */
export function recordAttempt(entry, nowMs) {
    const iso = new Date(nowMs).toISOString();
    return {...entry, lastAttemptAt: iso, recent: [...recentAttempts(entry, nowMs), iso]};
}

export function activeInterval(requestedS) {
    const n = Number(requestedS);
    return Math.max(ACTIVE_MIN_S, Number.isFinite(n) && n > 0 ? n : ACTIVE_DEFAULT_S);
}

/** Seconds to wait after the last attempt, given its outcome. */
export function intervalFor(entry, isActive, activeS) {
    if (entry?.lastError === 'network' || entry?.lastError === 'timeout')
        return NETWORK_ERROR_S;
    return isActive ? activeInterval(activeS) : INACTIVE_S;
}

/**
 * @param {object|undefined} entry cache entry {lastAttemptAt, blockedUntil, lastError}
 * @param {number} nowMs
 * @param {{isActive: boolean, activeS?: number, force?: boolean}} o
 */
export function isDue(entry, nowMs, {isActive, activeS, force = false}) {
    if (!entry?.lastAttemptAt)
        return true;
    if (entry.blockedUntil && nowMs < Date.parse(entry.blockedUntil))
        return false;
    if (recentAttempts(entry, nowMs).length >= HARD_CAP_PER_HOUR)
        return false;
    const last = Date.parse(entry.lastAttemptAt);
    if (!Number.isFinite(last))
        return true;
    if (force)
        return nowMs - last >= FORCE_MIN_S * 1000;
    return nowMs - last >= intervalFor(entry, isActive, activeS) * 1000;
}

export function nextPollAt(entry, isActive, activeS) {
    if (!entry?.lastAttemptAt)
        return null;
    const last = Date.parse(entry.lastAttemptAt);
    let t = last + intervalFor(entry, isActive, activeS) * 1000;
    if (entry.blockedUntil)
        t = Math.max(t, Date.parse(entry.blockedUntil));
    return new Date(t).toISOString();
}

/** blockedUntil for a 429 (Retry-After + margin, or one hour). */
export function blockAfter429(nowMs, retryAfterS) {
    const wait = Number.isFinite(retryAfterS) && retryAfterS >= 0
        ? retryAfterS + RATE_LIMIT_MARGIN_S
        : RATE_LIMIT_DEFAULT_S;
    return new Date(nowMs + wait * 1000).toISOString();
}
