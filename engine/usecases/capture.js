// "The backup follows the live session".

import {readLive} from '../adapters/claudeFiles.js';
import {withLocks} from '../adapters/lock.js';
import {
    classifyLocal, resolveRotated, captureAction, PASSIVE_KINDS,
} from '../domain/capture.js';
import {_} from '../lib/i18n.js';
import {isExpired, accessToken, hasTokens, stripShared, parseObject} from '../domain/credential.js';

const HEALTHY = new Set(['same', 'newer', 'rotated-own']);

export const WARNINGS = {
    'foreign': () => _('The current session does not match its saved account; a backup was saved and no account was touched.'),
    'alien': () => _('The current session belongs to an account Claude Account Switcher does not know; a backup was saved.'),
    'rotated-unverified': () => _('The latest copy of the active account could not be confirmed (offline); the previous one was backed up.'),
    'wiped': () => _('Claude Code lost the session of the active account: sign in again.'),
};

/**
 * Classify the live session. `network` allows one /api/oauth/profile call for
 * a rotated lineage (must never run while Claude Code's locks are held).
 */
export function planCapture(ctx, snap, reg, {network}) {
    const slotCreds = new Map(reg.accounts.map(a => [a.uuid, ctx.store.readSlotCred(a.uuid)]));
    let c = classifyLocal({live: snap.cred, liveAccount: snap.account, registry: reg, slotCreds});
    if (c.kind === 'rotated') {
        let profile = null;
        if (network && !isExpired(snap.cred, ctx.clock()))
            profile = ctx.http.profile(accessToken(snap.cred));
        c = network ? resolveRotated(c, profile, reg) : {...c, unresolved: true};
    }
    return {...c, snap};
}

/**
 * Apply a plan. The caller holds claude-accounts.lock (and, during a switch, Claude
 * Code's locks). Returns true if the registry changed.
 */
export function applyCapture(ctx, plan, reg) {
    const {snap} = plan;
    const entry = plan.account ? reg.accounts.find(a => a.uuid === plan.account.uuid) : null;
    const act = captureAction(plan.kind);
    let changed = false;

    if (act.copyToSlot && entry) {
        withLocks(ctx.paths.slotCredLocks(entry.uuid), () => {
            if (act.stashPrevious) {
                const prev = parseObject(ctx.store.readSlotCredText(entry.uuid));
                if (prev)
                    ctx.store.stash('superseded', {accountUuid: entry.uuid, credentials: prev});
            }
            ctx.store.writeSlotCred(entry.uuid, snap.cred);
            if (snap.account)
                ctx.store.writeSlotAccount(entry.uuid, snap.account);
        });
        const state = plan.kind === 'newer' && entry.state === 'unverified' ? 'unverified' : act.state;
        if (entry.state !== state) {
            entry.state = state;
            changed = true;
        }
        ctx.log.info(`capture account=${entry.number} kind=${plan.kind}`);
    }
    if (act.stashLive && hasTokens(snap.cred)) {
        ctx.store.stash(plan.kind, {accountUuid: entry?.uuid ?? null, credentials: stripShared(snap.cred)});
        ctx.log.warn(`capture kind=${plan.kind} account=${entry?.number ?? '-'} live credential stashed`);
    }
    if (act.markNeedsLogin && entry && entry.state !== 'needs-login') {
        entry.state = 'needs-login';
        changed = true;
        ctx.log.warn(`capture account=${entry.number} wiped -> needs-login`);
    }
    // The user fixed the account with /login in Claude Code.
    if (entry && HEALTHY.has(plan.kind) && entry.state === 'needs-login' && hasTokens(snap.cred)) {
        entry.state = 'ok';
        changed = true;
    }
    if (entry && snap.account && HEALTHY.has(plan.kind)) {
        for (const [k, src] of [['email', 'emailAddress'], ['orgName', 'organizationName']]) {
            if (snap.account[src] && entry[k] !== snap.account[src]) {
                entry[k] = snap.account[src];
                changed = true;
            }
        }
    }
    if (changed)
        ctx.store.saveRegistry(reg);
    return changed;
}

/**
 * Capture for list/status: plan (maybe with network), then apply under
 * claude-accounts.lock only if the live credential did not move meanwhile.
 */
export function captureLive(ctx, {network = true} = {}) {
    const snap = readLive(ctx.paths);
    let reg = ctx.store.loadRegistry();
    const plan = planCapture(ctx, snap, reg, {network});
    if (plan.unresolved || PASSIVE_KINDS.has(plan.kind))
        return plan;
    withLocks([ctx.paths.accountsLock], () => {
        const again = readLive(ctx.paths);
        if (again.credText !== snap.credText || again.configText !== snap.configText)
            return; // Claude Code wrote meanwhile: the next run captures it
        reg = ctx.store.loadRegistry();
        applyCapture(ctx, plan, reg);
    });
    if (WARNINGS[plan.kind])
        ctx.warnings.push(WARNINGS[plan.kind]());
    return plan;
}
