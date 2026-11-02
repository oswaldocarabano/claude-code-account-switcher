// remove / alias / disable / enable / doctor.

import GLib from 'gi://GLib';
import System from 'system';
import {withLocks} from '../adapters/lock.js';
import {readLive} from '../adapters/claudeFiles.js';
import {exists, modeOf, mtimeMs} from '../adapters/atomicFile.js';
import {resolveAccount} from '../adapters/store.js';
import {findAccountFor} from '../domain/capture.js';
import {EngineError} from '../lib/errors.js';
import {VERSION} from '../lib/version.js';
import {_, fmt} from '../lib/i18n.js';

function mutate(ctx, ident, fn) {
    ctx.store.ensure();
    return withLocks([ctx.paths.accountsLock], () => {
        const reg = ctx.store.loadRegistry();
        const e = resolveAccount(reg, ident);
        if (!e)
            throw new EngineError('not-found', fmt(_('There is no account “%s”.'), ident));
        const out = fn(reg, e);
        ctx.store.saveRegistry(reg);
        return out;
    });
}

export function removeAccount(ctx, ident) {
    return mutate(ctx, ident, (reg, e) => {
        const live = readLive(ctx.paths);
        if (findAccountFor(reg, live.account)?.uuid === e.uuid)
            throw new EngineError('active', _('The active account cannot be removed. Switch to another one first.'));
        const stashed = ctx.store.stashSlotDir(e.uuid);
        reg.accounts = reg.accounts.filter(a => a.uuid !== e.uuid);
        ctx.log.info(`remove account=${e.number}`);
        return {removed: {number: e.number, email: e.email}, stash: stashed};
    });
}

export function setAlias(ctx, ident, alias) {
    const clean = alias === null ? null : String(alias).trim().slice(0, 32);
    return mutate(ctx, ident, (reg, e) => {
        if (clean && /^\d+$/.test(clean))
            throw new EngineError('invalid', _('An alias cannot be just a number.'));
        if (clean && reg.accounts.some(a => a.uuid !== e.uuid && a.alias === clean))
            throw new EngineError('invalid', fmt(_('The alias “%s” is already in use.'), clean));
        e.alias = clean || null;
        return {number: e.number, alias: e.alias};
    });
}

export function setDisabled(ctx, ident, disabled) {
    return mutate(ctx, ident, (_reg, e) => {
        e.disabled = Boolean(disabled);
        return {number: e.number, disabled: e.disabled};
    });
}

/** Checks that need no login. */
export function doctor(ctx) {
    const p = ctx.paths;
    const checks = [];
    const add = (id, ok, detail) => checks.push({id, ok, detail});

    add('claude', ctx.claude.available, ctx.claude.version() ?? 'not found');
    add('credentials', exists(p.credentials), p.credentials);
    const mode = modeOf(p.credentials);
    add('credentials-mode', mode === null || mode === 0o600, mode === null ? '-' : mode.toString(8));
    add('global-config', exists(p.globalConfig), p.globalConfig);
    const live = readLive(p);
    add('live-format', !live.cred || Boolean(live.cred.claudeAiOauth), live.cred ? 'claudeAiOauth' : 'no session');
    add('data-dir-mode', !exists(p.dataDir) || modeOf(p.dataDir) === 0o700,
        exists(p.dataDir) ? modeOf(p.dataDir).toString(8) : 'not created');
    const locks = [...p.liveCredLocks, p.configLock, p.accountsLock].map(l => {
        const m = mtimeMs(l.path);
        return {path: l.path, held: m !== null, ageS: m === null ? null : Math.round((Date.now() - m) / 1000)};
    });
    add('locks', locks.every(l => !l.held || l.ageS * 1000 < 60000), locks.filter(l => l.held));
    add('owner-record', true, exists(`${p.claudeHome}/.oauth_refresh.lock.owner`)
        ? 'present (Claude Code refreshing)' : 'absent');
    if (ctx.claude.available && live.cred) {
        const s = ctx.claude.status(null, 20);
        const fields = s && !s.timedOut ? Object.keys(s).sort() : [];
        add('auth-status-fields', ['email', 'loggedIn', 'orgId'].every(f => fields.includes(f)), fields);
    }
    return {
        version: VERSION,
        gjs: System.version,
        glib: `${GLib.MAJOR_VERSION}.${GLib.MINOR_VERSION}`,
        strategy: ctx.strategy,
        paths: {data: p.dataDir, cache: p.cacheDir, log: p.logFile},
        checks,
        ok: checks.every(c => c.ok),
    };
}
