// Pure helpers over Claude Code credential blobs.
// No I/O here: everything takes parsed objects and returns new values.

import GLib from 'gi://GLib';

/** Sibling keys of claudeAiOauth that belong to the machine, not the account. */
export const SHARED_KEYS = Object.freeze([
    'mcpOAuth',
    'mcpOAuthClientConfig',
    'mcpXaaIdp',
    'mcpXaaIdpConfig',
    'pluginSecrets',
]);

/**
 * @param {string|null} text
 * @returns {object|null} a JSON object, or null if missing or not an object
 */
export function parseObject(text) {
    if (text === null || text === undefined)
        return null;
    try {
        const o = JSON.parse(text);
        return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch {
        return null;
    }
}

export function oauthOf(cred) {
    const o = cred?.claudeAiOauth;
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
}

/** Both tokens present and non-empty. */
export function hasTokens(cred) {
    const o = oauthOf(cred);
    return Boolean(o &&
        typeof o.accessToken === 'string' && o.accessToken.length > 0 &&
        typeof o.refreshToken === 'string' && o.refreshToken.length > 0);
}

/** Claude Code empties both tokens in place after an invalid_grant. */
export function isWiped(cred) {
    const o = oauthOf(cred);
    return Boolean(o) && !o.accessToken && !o.refreshToken;
}

export function sha256(s) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, s, -1);
}

/** Lineage fingerprint: hash of the refresh token (null if none). */
export function refreshFp(cred) {
    const rt = oauthOf(cred)?.refreshToken;
    return typeof rt === 'string' && rt ? `rt:${sha256(rt)}` : null;
}

export function accessToken(cred) {
    const at = oauthOf(cred)?.accessToken;
    return typeof at === 'string' && at ? at : null;
}

export function expiresAt(cred) {
    const v = oauthOf(cred)?.expiresAt;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** True if the access token is expired or expires within bufferMs. */
export function isExpired(cred, nowMs, bufferMs = 0) {
    return expiresAt(cred) - bufferMs <= nowMs;
}

/** ISO date when the login itself lapses (refreshTokenExpiresAt), or null. */
export function loginExpiresAt(cred) {
    const v = oauthOf(cred)?.refreshTokenExpiresAt;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)
        return null;
    return new Date(v).toISOString().replace('.000Z', 'Z');
}

/** Structural check before trusting a blob. Returns an error string or null. */
export function shapeError(cred) {
    const o = oauthOf(cred);
    if (!o)
        return 'missing claudeAiOauth';
    for (const k of ['accessToken', 'refreshToken']) {
        if (k in o && typeof o[k] !== 'string')
            return `${k} is not a string`;
    }
    if ('expiresAt' in o && typeof o.expiresAt !== 'number')
        return 'expiresAt is not a number';
    return null;
}

/** Copy without the machine-shared keys (slots never store them). */
export function stripShared(cred) {
    const out = JSON.parse(JSON.stringify(cred));
    for (const k of SHARED_KEYS)
        delete out[k];
    return out;
}

/**
 * Credential to activate: the slot's blob, but machine-shared keys come from
 * the live credential (absence included).
 */
export function composeForActivation(target, live) {
    const out = stripShared(target);
    if (!live || typeof live !== 'object')
        return out;
    for (const k of SHARED_KEYS) {
        if (k in live)
            out[k] = live[k];
    }
    return out;
}

/** Same account-scoped content (ignoring machine-shared keys). */
export function sameAccountContent(a, b) {
    if (!a || !b)
        return false;
    return JSON.stringify(stripShared(a)) === JSON.stringify(stripShared(b));
}

/**
 * Apply a token-endpoint response to a blob (direct refresh). Never touches
 * scopes (CCSwitcher: the CLI requires user:inference in the stored scopes).
 */
export function applyTokenResponse(cred, resp, nowMs) {
    const out = JSON.parse(JSON.stringify(cred));
    const o = out.claudeAiOauth;
    o.accessToken = resp.access_token;
    o.expiresAt = nowMs + Number(resp.expires_in) * 1000;
    if (typeof resp.refresh_token === 'string' && resp.refresh_token)
        o.refreshToken = resp.refresh_token;
    return out;
}
