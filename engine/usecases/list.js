// `claude-accounts list` and `claude-accounts status`.

import {readLive} from '../adapters/claudeFiles.js';
import {withLocks} from '../adapters/lock.js';
import {loadUsageCache, mergeUsageCache} from '../adapters/usageCache.js';
import {scanSessions} from '../adapters/sessions.js';
import {captureLive} from './capture.js';
import {fetchUsageFor} from './usage.js';
import {withEstimates} from '../domain/usage.js';
import {isDue, nextPollAt, blockAfter429, recordAttempt} from '../domain/pollPolicy.js';
import {loginExpiresAt} from '../domain/credential.js';

const NOT_ACTIVE = new Set(['none', 'unmanaged']);
const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

export function activeOf(plan) {
    return plan.account && !NOT_ACTIVE.has(plan.kind) ? plan.account : null;
}

function captureName(plan) {
    if (plan.unresolved)
        return 'rotated-unverified';
    return plan.kind;
}

function activeSummary(plan, reg) {
    const acct = activeOf(plan);
    const entry = acct ? reg.accounts.find(a => a.uuid === acct.uuid) : null;
    return {
        number: entry?.number ?? null,
        email: plan.snap.account?.emailAddress ?? entry?.email ?? null,
        managed: Boolean(entry),
        capture: captureName(plan),
    };
}

export function isPersonalOrg(entry) {
    return !entry.orgName || entry.orgName === `${entry.email}'s Organization`;
}

function accountView(ctx, entry, activeUuid, liveCred, cache) {
    const isActive = entry.uuid === activeUuid;
    const c = cache.accounts[entry.uuid];
    const cred = isActive ? liveCred : ctx.store.readSlotCred(entry.uuid);
    return {
        number: entry.number,
        uuid: entry.uuid,
        email: entry.email,
        alias: entry.alias ?? null,
        orgName: entry.orgName ?? '',
        isPersonalOrg: isPersonalOrg(entry),
        active: isActive,
        disabled: Boolean(entry.disabled),
        state: entry.state ?? 'ok',
        loginExpiresAt: loginExpiresAt(cred),
        usage: c?.usage ? withEstimates(c.usage, ctx.clock()) : null,
        usageFetchedAt: c?.fetchedAt ?? null,
        usageError: c?.lastError ?? null,
        nextPollAt: nextPollAt(c, isActive, ctx.activeIntervalS),
    };
}

/**
 * @param {object} ctx
 * @param {{cached?: boolean, force?: boolean}} o
 */
export function list(ctx, {cached = false, force = false} = {}) {
    ctx.store.ensure();
    const plan = captureLive(ctx, {network: !cached});
    let reg = ctx.store.loadRegistry();
    const live = readLive(ctx.paths);
    const activeUuid = activeOf(plan)?.uuid ?? null;
    let cache = loadUsageCache(ctx.paths);

    if (!cached) {
        const updates = {};
        const ordered = [...reg.accounts].sort((a, b) =>
            (b.uuid === activeUuid) - (a.uuid === activeUuid) || a.number - b.number);
        for (const a of ordered) {
            if (a.state === 'needs-login')
                continue;
            const isActive = a.uuid === activeUuid;
            const entry = cache.accounts[a.uuid];
            if (!isDue(entry, ctx.clock(), {isActive, activeS: ctx.activeIntervalS, force}))
                continue;
            const r = fetchUsageFor(ctx, a, isActive, live.cred);
            const now = ctx.clock();
            const next = recordAttempt(entry, now);
            if (!r.error) {
                Object.assign(next, {usage: r.usage, fetchedAt: iso(now), lastError: null, blockedUntil: null});
            } else {
                next.lastError = r.error;
                if (r.error === 'http-429')
                    next.blockedUntil = blockAfter429(now, r.retryAfterS);
            }
            updates[a.uuid] = next;
        }
        if (Object.keys(updates).length) {
            cache = withLocks([ctx.paths.accountsLock], () => mergeUsageCache(ctx.paths, updates));
            reg = ctx.store.loadRegistry(); // refreshes may have changed states
        }
    }

    return {
        active: activeSummary(plan, reg),
        accounts: reg.accounts.map(e => accountView(ctx, e, activeUuid, live.cred, cache)),
        sessions: scanSessions(ctx.paths),
        warnings: ctx.warnings,
    };
}

/** No network at all. */
export function status(ctx) {
    ctx.store.ensure();
    const plan = captureLive(ctx, {network: false});
    const reg = ctx.store.loadRegistry();
    return {active: activeSummary(plan, reg), accounts: reg.accounts.length, warnings: ctx.warnings};
}
