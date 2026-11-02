// Usage fetch for one account.

import {HttpError} from '../adapters/http.js';
import {normalizeUsage} from '../domain/usage.js';
import {accessToken, hasTokens, isExpired} from '../domain/credential.js';
import {refreshSlot} from './refresh.js';

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * @returns {{usage?: object|null, error?: string, retryAfterS?: number|null}}
 */
export function fetchUsageFor(ctx, account, isActive, liveCred) {
    let token;
    if (isActive) {
        token = accessToken(liveCred); // never refreshed by us: Claude Code owns it
        if (!token)
            return {error: 'needs-login'};
    } else {
        const cred = ctx.store.readSlotCred(account.uuid);
        if (!cred || !hasTokens(cred))
            return {error: 'needs-login'};
        if (isExpired(cred, ctx.clock(), EXPIRY_BUFFER_MS)) {
            const r = refreshSlot(ctx, account);
            if (r === 'needs-login')
                return {error: 'needs-login'};
            if (r === 'skipped-live')
                return {error: 'refresh-failed'};
            if (r !== 'refreshed' && r !== 'fresh')
                return {error: 'refresh-failed'};
        }
        token = accessToken(ctx.store.readSlotCred(account.uuid));
    }

    const attempt = t => {
        try {
            return {usage: normalizeUsage(ctx.http.usage(t))};
        } catch (e) {
            if (e instanceof HttpError)
                return {error: e.kind, retryAfterS: e.retryAfterS};
            return {error: 'internal'};
        }
    };
    let r = attempt(token);
    if (r.error === 'http-401' && !isActive) {
        const rr = refreshSlot(ctx, account, {force: true});
        if (rr === 'needs-login')
            return {error: 'needs-login'};
        if (rr === 'refreshed')
            r = attempt(accessToken(ctx.store.readSlotCred(account.uuid)));
    }
    if (r.error)
        ctx.log.warn(`usage account=${account.number} error=${r.error}`);
    return r;
}
