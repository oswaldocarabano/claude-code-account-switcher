// Refresh of saved (inactive) accounts only.
// Never the live credential, never a copy sharing the live lineage.

import {readLive} from '../adapters/claudeFiles.js';
import {withLocks} from '../adapters/lock.js';
import {_} from '../lib/i18n.js';
import {
    hasTokens, isWiped, isExpired, refreshFp, applyTokenResponse,
} from '../domain/credential.js';

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function markNeedsLogin(ctx, uuid) {
    const reg = ctx.store.loadRegistry();
    const e = reg.accounts.find(a => a.uuid === uuid);
    if (e && e.state !== 'needs-login') {
        e.state = 'needs-login';
        ctx.store.saveRegistry(reg);
        ctx.log.warn(`refresh account=${e.number} -> needs-login`);
    }
}

function delegate(ctx, uuid, cred, force) {
    const pre = ctx.store.stash('pre-refresh', {accountUuid: uuid, credentials: cred});
    if (force) {
        // claude only refreshes an expired token: expire our own copy first.
        const forced = JSON.parse(JSON.stringify(cred));
        forced.claudeAiOauth.expiresAt = 0;
        ctx.store.writeSlotCred(uuid, forced);
    }
    const res = ctx.claude.status(ctx.store.slotDir(uuid), 20);
    const after = ctx.store.readSlotCred(uuid);
    if (after && hasTokens(after) && refreshFp(after) !== refreshFp(cred) &&
        !isExpired(after, ctx.clock())) {
        ctx.store.removeStash(pre);
        return 'refreshed';
    }
    if (!after || isWiped(after) || !hasTokens(after))
        return 'needs-login'; // the pre-refresh copy stays in stash/
    if (force)
        ctx.store.writeSlotCred(uuid, cred); // undo the forced expiry
    else
        ctx.store.removeStash(pre);
    return res?.timedOut ? 'timeout' : 'transient';
}

function direct(ctx, uuid, force) {
    return withLocks(ctx.paths.slotCredLocks(uuid), () => {
        const cred = ctx.store.readSlotCred(uuid);
        if (!cred || !hasTokens(cred))
            return 'needs-login';
        if (!force && !isExpired(cred, ctx.clock(), EXPIRY_BUFFER_MS))
            return 'fresh';
        const r = ctx.http.refresh(cred.claudeAiOauth.refreshToken);
        if (r.ok) {
            ctx.store.writeSlotCred(uuid, applyTokenResponse(cred, r.resp, ctx.clock()));
            return 'refreshed';
        }
        if (r.error === 'invalid_grant')
            return 'needs-login';
        if (r.error === 'invalid_client')
            return 'invalid-client';
        return 'transient';
    });
}

/**
 * @param {object} ctx
 * @param {{uuid: string, number: number}} account
 * @param {{force?: boolean, holdingOwnLock?: boolean}} [o]
 * @returns {string} refreshed | fresh | needs-login | transient | timeout | skipped-live
 */
export function refreshSlot(ctx, account, {force = false, holdingOwnLock = false} = {}) {
    const run = () => {
        const cred = ctx.store.readSlotCred(account.uuid);
        if (!cred || !hasTokens(cred)) {
            markNeedsLogin(ctx, account.uuid);
            return 'needs-login';
        }
        const live = readLive(ctx.paths).cred;
        if (live && refreshFp(live) && refreshFp(live) === refreshFp(cred))
            return 'skipped-live';
        if (!force && !isExpired(cred, ctx.clock(), EXPIRY_BUFFER_MS))
            return 'fresh';

        let strategy = ctx.strategy;
        if (strategy === 'delegate' && !ctx.claude.available)
            strategy = 'direct';
        let result = strategy === 'delegate'
            ? delegate(ctx, account.uuid, cred, force)
            : direct(ctx, account.uuid, force);
        if (result === 'invalid-client') {
            ctx.warnings.push(_('The server rejected the OAuth client; the official CLI will be used to renew.'));
            if (ctx.claude.available) {
                ctx.strategy = 'delegate';
                result = delegate(ctx, account.uuid, cred, force);
            } else {
                result = 'transient';
            }
        }
        if (result === 'needs-login')
            markNeedsLogin(ctx, account.uuid);
        ctx.log.info(`refresh account=${account.number} strategy=${strategy} result=${result}`);
        return result;
    };
    return holdingOwnLock ? run() : withLocks([ctx.paths.accountsLock], run);
}
