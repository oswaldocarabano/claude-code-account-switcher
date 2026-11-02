// `claude-accounts add --current` and `claude-accounts add --login`.

import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import Gio from 'gi://Gio';
import {readLive} from '../adapters/claudeFiles.js';
import {withLocks} from '../adapters/lock.js';
import {
    readText, writeAtomic, removeFile, removeTree, move, listDir,
} from '../adapters/atomicFile.js';
import {entryFromAccount} from '../adapters/store.js';
import {captureLive} from './capture.js';
import {switchAccount} from './switch.js';
import {
    parseObject, hasTokens, shapeError, stripShared,
} from '../domain/credential.js';
import {EngineError} from '../lib/errors.js';
import {_, fmt} from '../lib/i18n.js';

const LOGIN_TIMEOUT_S = 300;

function registerOrUpdate(ctx, account, cred, {reason}) {
    return withLocks([ctx.paths.accountsLock], () => {
        const reg = ctx.store.loadRegistry();
        let entry = reg.accounts.find(a => a.uuid === account.accountUuid);
        const isNew = !entry;
        withLocks(ctx.paths.slotCredLocks(account.accountUuid), () => {
            if (!isNew) {
                const prev = ctx.store.readSlotCred(account.accountUuid);
                if (prev)
                    ctx.store.stash(reason, {accountUuid: account.accountUuid, credentials: prev});
            }
            ctx.store.writeSlotCred(account.accountUuid, cred);
            ctx.store.writeSlotAccount(account.accountUuid, account);
        });
        if (isNew) {
            entry = entryFromAccount(account, reg.nextNumber, ctx.clock());
            reg.nextNumber += 1;
            reg.accounts.push(entry);
        } else {
            entry.state = 'ok';
            entry.email = account.emailAddress ?? entry.email;
            entry.orgName = account.organizationName ?? entry.orgName;
        }
        ctx.store.saveRegistry(reg);
        ctx.log.info(`add account=${entry.number} new=${isNew} via=${reason}`);
        return {entry, isNew};
    });
}

const view = e => ({number: e.number, email: e.email, alias: e.alias ?? null});

export function addCurrent(ctx) {
    ctx.store.ensure();
    const snap = readLive(ctx.paths);
    if (!snap.cred || !snap.cred.claudeAiOauth)
        throw new EngineError('no-session', _('Claude Code is not signed in.'));
    if (!hasTokens(snap.cred))
        throw new EngineError('wiped', _('The current Claude Code session has no tokens: sign in again.'));
    if (!snap.account?.accountUuid)
        throw new EngineError('no-session', _('oauthAccount was not found in the Claude Code configuration.'));
    const reg = ctx.store.loadRegistry();
    if (reg.accounts.some(a => a.uuid === snap.account.accountUuid)) {
        captureLive(ctx, {network: true});
        const e = ctx.store.loadRegistry().accounts.find(a => a.uuid === snap.account.accountUuid);
        return {added: false, updated: true, account: view(e)};
    }
    const {entry} = registerOrUpdate(ctx, snap.account, stripShared(snap.cred), {reason: 'readd'});
    return {added: true, updated: false, account: view(entry)};
}

function writeBrowserScript(dir) {
    const script = `${dir}/browser.sh`;
    const open = GLib.getenv('CLAUDE_ACCOUNTS_NO_BROWSER') === '1' ? ':' : 'xdg-open "$1" >/dev/null 2>&1 &';
    writeAtomic(script, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${dir}/url"\n${open}\n`, 0o700);
    return script;
}

/** SIGTERM handler (GLibUnix, GLib >= 2.80). */
function onSigterm(cb) {
    return GLibUnix.signal_add_full(GLib.PRIORITY_HIGH, 15, cb);
}

/**
 * Isolated login: `claude auth login` with CLAUDE_CONFIG_DIR=<tmp>, BROWSER
 * intercepted. The live session is never touched. Emits JSON-line events.
 *
 * @param {object} ctx
 * @param {{activate?: boolean, emit: (ev: object) => void}} o
 * @returns {object} final result
 */
export function addLogin(ctx, {activate = false, emit}) {
    ctx.store.ensure();
    if (!ctx.claude.available)
        throw new EngineError('claude-not-found', _('Claude Code (claude) was not found.'));
    const dir = ctx.store.newTmpDir('login-');
    writeAtomic(`${dir}/engine.pid`, `${new Gio.Credentials().get_unix_pid()}\n`);
    const browser = writeBrowserScript(dir);

    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_SILENCE |
            Gio.SubprocessFlags.STDERR_SILENCE,
    });
    launcher.setenv('CLAUDE_CONFIG_DIR', dir, true);
    launcher.setenv('BROWSER', browser, true);
    let proc;
    try {
        proc = launcher.spawnv([ctx.claude.path, 'auth', 'login']);
    } catch (e) {
        removeTree(dir);
        throw new EngineError('claude-not-found', fmt(_('Could not start claude: %s'), e.message));
    }
    proc.get_stdin_pipe()?.close(null); // stdin closed (verified against Claude Code 2.1.316)

    const loop = new GLib.MainLoop(null, false);
    let outcome = null;
    let urlSent = false;
    emit({event: 'waiting'});
    const checkUrl = () => {
        if (urlSent)
            return;
        const url = readText(`${dir}/url`)?.split('\n')[0];
        if (url) {
            urlSent = true;
            emit({event: 'auth-url', url});
        }
    };
    const poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
        checkUrl();
        return GLib.SOURCE_CONTINUE;
    });
    const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LOGIN_TIMEOUT_S, () => {
        outcome = 'timeout';
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    const sig = onSigterm(() => {
        outcome = 'cancelled';
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    proc.wait_async(null, () => loop.quit());
    loop.run();
    checkUrl(); // a fast login can finish before the first poll
    for (const id of [poll, timeout, sig]) {
        try {
            GLib.source_remove(id);
        } catch {
            // already removed
        }
    }

    try {
        if (outcome) {
            throw new EngineError(outcome === 'timeout' ? 'timeout' : 'cancelled',
                outcome === 'timeout' ? _('Sign-in took too long.') : _('Sign-in cancelled.'));
        }
        if (!proc.get_if_exited() || proc.get_exit_status() !== 0)
            throw new EngineError('login-failed', _('Claude Code did not complete the sign-in.'));
        const cred = parseObject(readText(`${dir}/.credentials.json`));
        const account = parseObject(readText(`${dir}/.claude.json`))?.oauthAccount;
        if (!cred || shapeError(cred) || !hasTokens(cred) || !account?.accountUuid)
            throw new EngineError('login-failed', _('The sign-in did not leave a valid credential.'));

        const reg = ctx.store.loadRegistry();
        const exists = reg.accounts.some(a => a.uuid === account.accountUuid);
        let result;
        if (!exists) {
            for (const f of ['browser.sh', 'url', 'engine.pid'])
                removeFile(`${dir}/${f}`);
            withLocks([ctx.paths.accountsLock], () => {
                move(dir, ctx.store.slotDir(account.accountUuid));
                const r2 = ctx.store.loadRegistry();
                const entry = entryFromAccount(account, r2.nextNumber, ctx.clock());
                r2.nextNumber += 1;
                r2.accounts.push(entry);
                // normalise the stored files (no shared keys, our formatting)
                ctx.store.writeSlotCred(account.accountUuid, cred);
                ctx.store.saveRegistry(r2);
                ctx.log.info(`add account=${entry.number} new=true via=login`);
                result = {added: true, account: view(entry)};
            });
        } else {
            const {entry} = registerOrUpdate(ctx, account, stripShared(cred), {reason: 'relogin'});
            removeTree(dir);
            result = {added: false, renewed: true, account: view(entry)};
        }
        if (activate) {
            const sw = switchAccount(ctx, {ident: String(result.account.number)});
            result.activated = sw.result.switched || sw.result.reason === 'already-active';
            result.switch = sw.result;
        }
        return result;
    } catch (e) {
        removeTree(dir);
        throw e;
    }
}

/** `claude-accounts add --cancel`: SIGTERM every engine running a login. */
export function cancelLogins(ctx) {
    let n = 0;
    for (const name of listDir(ctx.paths.tmpDir)) {
        if (!name.startsWith('login-'))
            continue;
        const pid = Number(readText(`${ctx.paths.tmpDir}/${name}/engine.pid`));
        if (Number.isInteger(pid) && pid > 0) {
            GLib.spawn_command_line_sync(`kill -TERM ${pid}`);
            n++;
        }
    }
    return {cancelled: n};
}
