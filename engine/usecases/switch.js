// `claude-accounts switch`. Only the account credential and oauthAccount
// change; every conversation, project and setting stays.

import {readLive, writeLiveCredentials, writeLiveAccount, restoreBytes} from '../adapters/claudeFiles.js';
import {acquireAll} from '../adapters/lock.js';
import {removeFile} from '../adapters/atomicFile.js';
import {scanSessions} from '../adapters/sessions.js';
import {loadUsageCache} from '../adapters/usageCache.js';
import {resolveAccount} from '../adapters/store.js';
import {planCapture, applyCapture, WARNINGS} from './capture.js';
import {refreshSlot} from './refresh.js';
import {activeOf} from './list.js';
import {
    hasTokens, isExpired, composeForActivation, stripShared, sameAccountContent,
} from '../domain/credential.js';
import {withEstimates} from '../domain/usage.js';
import {pickBest} from '../domain/pick.js';
import {EngineError} from '../lib/errors.js';
import {fault} from '../lib/fault.js';
import {_, ngettext, fmt} from '../lib/i18n.js';

const ACTIVATE_MARGIN_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const ALREADY = new Set(['same', 'newer', 'rotated-own', 'rotated-unverified']);
/** Kinds that may be applied without network while Claude Code's locks are held. */
const LOCAL_OK = new Set(['same', 'newer', 'none', 'unmanaged', 'wiped', 'foreign']);

const ref = e => (e ? {number: e.number, email: e.email} : null);

function chooseBest(ctx, reg, activeUuid) {
    const cache = loadUsageCache(ctx.paths);
    const usage = new Map(reg.accounts.map(a =>
        [a.uuid, withEstimates(cache.accounts[a.uuid]?.usage ?? null, ctx.clock())]));
    return pickBest(reg.accounts, usage, activeUuid);
}

function verify(ctx, target) {
    if (!ctx.claude.available)
        return null;
    const s = ctx.claude.status(null, 20);
    if (!s || s.timedOut)
        return null;
    return s.email === target.email && (!target.orgUuid || !s.orgId || s.orgId === target.orgUuid);
}

/**
 * @param {object} ctx
 * @param {{ident?: string, best?: boolean}} o
 */
export function switchAccount(ctx, {ident = null, best = false}) {
    ctx.store.ensure();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // ---- 4.1 before any Claude Code lock (network allowed) ----
        let reg = ctx.store.loadRegistry();
        const snap = readLive(ctx.paths);
        const plan = planCapture(ctx, snap, reg, {network: true});
        const activeUuid = activeOf(plan)?.uuid ?? null;

        const target = best ? chooseBest(ctx, reg, activeUuid) : resolveAccount(reg, ident);
        if (!target) {
            if (best)
                return {result: {switched: false, reason: 'no-candidate', from: ref(activeOf(plan)), to: null}, exit: 2};
            throw new EngineError('not-found', fmt(_('There is no account “%s”.'), ident));
        }
        if (target.uuid === activeUuid && ALREADY.has(plan.kind)) {
            return {
                result: {switched: false, reason: 'already-active', from: ref(target), to: ref(target)},
                exit: 2,
            };
        }
        if (target.state === 'needs-login')
            throw new EngineError('needs-login', fmt(_('Account %d (%s) needs to sign in again.'), target.number, target.email));

        let tCred = ctx.store.readSlotCred(target.uuid);
        if (!tCred || !hasTokens(tCred))
            throw new EngineError('needs-login', fmt(_('The copy of account %d has no tokens.'), target.number));
        if (isExpired(tCred, ctx.clock(), ACTIVATE_MARGIN_MS)) {
            const r = refreshSlot(ctx, target);
            if (r === 'needs-login')
                throw new EngineError('needs-login', fmt(_('Account %d (%s) needs to sign in again.'), target.number, target.email));
            tCred = ctx.store.readSlotCred(target.uuid);
        }
        const tAccount = ctx.store.readSlotAccount(target.uuid);
        if (!tAccount?.accountUuid)
            throw new EngineError('switch-failed', fmt(_('Account %d has no saved oauthAccount.'), target.number));
        const sessions = scanSessions(ctx.paths);

        // ---- 4.2 with locks (disk only) ----
        const locks = acquireAll([ctx.paths.accountsLock, ...ctx.paths.liveCredLocks, ctx.paths.configLock]);
        let restart = false;
        let from = null;
        try {
            const snap2 = readLive(ctx.paths);
            let plan2 = plan;
            if (snap2.credText !== snap.credText || snap2.configText !== snap.configText) {
                plan2 = planCapture(ctx, snap2, reg, {network: false});
                if (!LOCAL_OK.has(plan2.kind))
                    restart = true; // Claude Code rotated meanwhile: verify again
            }
            if (!restart) {
                reg = ctx.store.loadRegistry();
                from = ref(activeOf(plan2) ? reg.accounts.find(a => a.uuid === activeOf(plan2).uuid) : null);
                const rollback = {cred: snap2.credText, config: snap2.configText};
                let wrote = false;
                try {
                    applyCapture(ctx, plan2, reg);
                    if (WARNINGS[plan2.kind])
                        ctx.warnings.push(WARNINGS[plan2.kind]());
                    fault('after-capture');
                    // Never destroy a live credential that no slot keeps.
                    if (['unmanaged', 'none'].includes(plan2.kind) && hasTokens(snap2.cred) &&
                        !sameAccountContent(snap2.cred, tCred))
                        ctx.store.stash('displaced-live-login', {credentials: stripShared(snap2.cred)});
                    locks.touch();
                    wrote = true;
                    fault('before-credentials');
                    writeLiveCredentials(ctx.paths, composeForActivation(tCred, snap2.cred));
                    fault('after-credentials');
                    writeLiveAccount(ctx.paths, tAccount,
                        bytes => ctx.store.stash('config-unreadable', {configText: bytes}));
                    fault('after-config');
                    locks.touch();
                } catch (e) {
                    if (!wrote)
                        throw e;
                    let rolledBack = true;
                    try {
                        restoreBytes(ctx.paths.credentials, rollback.cred, removeFile);
                        restoreBytes(ctx.paths.globalConfig, rollback.config, removeFile);
                    } catch {
                        rolledBack = false;
                    }
                    ctx.log.error(`switch to=${target.number} failed rolledBack=${rolledBack}`);
                    throw new EngineError('switch-failed', rolledBack
                        ? fmt(_('Could not switch account; the previous state was restored (%s).'), e.message)
                        : fmt(_('Could not switch account nor restore the previous state (%s). Backups are in stash/.'), e.message),
                    {rolledBack});
                }
            }
        } finally {
            locks.release();
        }
        if (restart)
            continue;

        // ---- 4.6 verify, without locks ----
        const verified = verify(ctx, target);
        const warnings = [...ctx.warnings];
        if (sessions.busy > 0) {
            warnings.push(fmt(ngettext(
                '%d Claude Code session is answering; it will use the new account on its next request.',
                '%d Claude Code sessions are answering; they will use the new account on their next request.',
                sessions.busy), sessions.busy));
        }
        if (verified === false)
            warnings.push(_('Claude Code still reports another account. Check with /status.'));
        ctx.log.info(`switch from=${from?.number ?? '-'} to=${target.number} verified=${verified}`);
        return {result: {switched: true, from, to: ref(target), verified, warnings}, exit: 0};
    }
    throw new EngineError('lock-timeout', _('Claude Code keeps renewing its credentials; try again in a few seconds.'));
}
