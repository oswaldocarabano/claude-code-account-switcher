// Path resolution. The engine always manages the DEFAULT profile
// (~/.claude) as the live session, even if CLAUDE_CONFIG_DIR is set in its
// environment, so a terminal using CLAUDE_CONFIG_DIR never confuses it.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {resolveSymlinks} from './atomicFile.js';

function isRegularFile(path) {
    return GLib.file_test(path, GLib.FileTest.IS_REGULAR);
}

function fileSize(path) {
    try {
        return Gio.File.new_for_path(path)
            .query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
    } catch {
        return 0;
    }
}

function isWritable(path) {
    try {
        return Gio.File.new_for_path(path)
            .query_info('access::can-write', Gio.FileQueryInfoFlags.NONE, null)
            .get_attribute_boolean('access::can-write');
    } catch {
        return false;
    }
}

/** Claude Code 2.1.299+ choice between <config>/.config.json and ~/.claude.json. */
export function pickGlobalConfig(configHome, base) {
    const legacy = `${configHome}/.config.json`;
    const global = `${base}/.claude.json`;
    if (isRegularFile(legacy) &&
        (fileSize(legacy) > 0 || (isWritable(legacy) && !GLib.file_test(global, GLib.FileTest.EXISTS))))
        return legacy;
    return global;
}

function realpath(path) {
    try {
        return resolveSymlinks(path);
    } catch {
        return path;
    }
}

function xdg(env, name, fallback) {
    const v = env(name);
    if (v) {
        const expanded = v.startsWith('~') ? env('HOME') + v.slice(1) : v;
        if (GLib.path_is_absolute(expanded))
            return expanded;
    }
    return fallback;
}

/**
 * @param {(name: string) => string|null} [env]
 */
export function makePaths(env = n => GLib.getenv(n)) {
    const home = env('HOME') || GLib.get_home_dir();
    const claudeHome = `${home}/.claude`;
    const dataDir = `${xdg(env, 'XDG_DATA_HOME', `${home}/.local/share`)}/claude-accounts`;
    const cacheDir = `${xdg(env, 'XDG_CACHE_HOME', `${home}/.cache`)}/claude-accounts`;
    const stateDir = `${xdg(env, 'XDG_STATE_HOME', `${home}/.local/state`)}/claude-accounts`;
    const globalConfig = pickGlobalConfig(claudeHome, home);

    const credLocksFor = dir => [
        {path: `${dir}/.oauth_refresh.lock`, staleMs: 60000, timeoutMs: 9000},
        {path: `${realpath(dir)}.lock`, staleMs: 60000, timeoutMs: 9000},
    ];

    return {
        home,
        claudeHome,
        credentials: `${claudeHome}/.credentials.json`,
        globalConfig,
        sessionsDir: `${claudeHome}/sessions`,
        dataDir,
        registry: `${dataDir}/registry.json`,
        accountsDir: `${dataDir}/accounts`,
        stashDir: `${dataDir}/stash`,
        tmpDir: `${dataDir}/tmp`,
        cacheDir,
        usageCache: `${cacheDir}/usage.json`,
        stateDir,
        logFile: `${stateDir}/claude-accounts.log`,
        accountsLock: {path: `${dataDir}/claude-accounts.lock`, staleMs: 60000, timeoutMs: 30000, owner: true},
        liveCredLocks: credLocksFor(claudeHome),
        configLock: {path: `${globalConfig}.lock`, staleMs: 10000, timeoutMs: 15000},
        slotDir: uuid => `${dataDir}/accounts/${uuid}`,
        slotCredLocks: uuid => credLocksFor(`${dataDir}/accounts/${uuid}`),
    };
}
