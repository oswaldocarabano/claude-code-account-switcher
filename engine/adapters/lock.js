// proper-lockfile compatible directory locks.
//
// - The lock is a directory; mkdir atomicity is the mutex.
// - A lock whose mtime is older than its staleness belongs to a dead holder and
//   is removed under a sibling "<lock>.takeover" directory, re-checked inside.
// - Holders touch the mtime; we hold locks for milliseconds and touch between
//   steps.
// - Claude Code's "<config>/.oauth_refresh.lock.owner" file is never written,
//   read or removed here.
// - Our own claude-accounts.lock records the holder pid inside the directory so a crashed
//   engine does not block the next one for 60 s.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {mtimeMs, touch, readText, removeFile} from './atomicFile.js';
import {isAlive, procStart, selfPid} from './procfs.js';
import {EngineError} from '../lib/errors.js';
import {_, fmt} from '../lib/i18n.js';

const TAKEOVER_STALE_MS = 5000;
const OWNER_FILE = 'owner';

function mkdir(path) {
    try {
        Gio.File.new_for_path(path).make_directory(null);
        return 'ok';
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return 'exists';
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
            return 'retry';
        }
        throw new EngineError('io', fmt(_('Could not create the lock %s: %s'), GLib.path_get_basename(path), e.message));
    }
}

function rmdir(path) {
    try {
        Gio.File.new_for_path(path).delete(null);
        return true;
    } catch {
        return false;
    }
}

function ownerDead(path) {
    const text = readText(`${path}/${OWNER_FILE}`);
    if (!text)
        return false;
    try {
        const o = JSON.parse(text);
        return !isAlive(o.pid, o.procStart);
    } catch {
        return false;
    }
}

/** Remove `path` if `stillDead()` holds, serialised through path.takeover. */
function removeIfStillDead(path, stillDead) {
    const takeover = `${path}.takeover`;
    if (mkdir(takeover) !== 'ok') {
        const m = mtimeMs(takeover);
        if (m !== null && Date.now() - m > TAKEOVER_STALE_MS)
            rmdir(takeover);
        return false;
    }
    try {
        if (!stillDead())
            return false;
        removeFile(`${path}/${OWNER_FILE}`);
        return rmdir(path);
    } finally {
        rmdir(takeover);
    }
}

/**
 * @param {{path: string, staleMs: number, timeoutMs: number, owner?: boolean}} spec
 * @returns {{path: string, touch: () => void, release: () => void}}
 */
export function acquire(spec) {
    const {path, staleMs, timeoutMs, owner = false} = spec;
    const start = Date.now();
    for (;;) {
        const r = mkdir(path);
        if (r === 'ok')
            break;
        if (r === 'retry')
            continue;
        const m = mtimeMs(path);
        if (m === null)
            continue; // released between mkdir and stat
        const stale = () => {
            const mm = mtimeMs(path);
            return mm !== null && (Date.now() - mm > staleMs || (owner && ownerDead(path)));
        };
        if (stale()) {
            if (!removeIfStillDead(path, stale))
                GLib.usleep(50000);
            continue;
        }
        if (Date.now() - start > timeoutMs) {
            throw new EngineError('lock-timeout',
                fmt(_('The lock %s is still held: Claude Code or another process is writing. Try again in a few seconds.'), GLib.path_get_basename(path)));
        }
        GLib.usleep(250000 + Math.floor(Math.random() * 250000));
    }
    if (owner) {
        const pid = selfPid();
        GLib.file_set_contents(`${path}/${OWNER_FILE}`,
            JSON.stringify({pid, procStart: procStart(pid)}));
    }
    let released = false;
    return {
        path,
        touch() {
            if (!released)
                touch(path);
        },
        release() {
            if (released)
                return;
            released = true;
            if (owner)
                removeFile(`${path}/${OWNER_FILE}`);
            rmdir(path);
        },
    };
}

/** Acquire several locks in order; release in reverse. */
export function acquireAll(specs) {
    const held = [];
    try {
        for (const s of specs)
            held.push(acquire(s));
    } catch (e) {
        for (const h of held.reverse())
            h.release();
        throw e;
    }
    return {
        touch() {
            for (const h of held)
                h.touch();
        },
        release() {
            for (const h of [...held].reverse())
                h.release();
        },
    };
}

/** Run fn while holding the locks. */
export function withLocks(specs, fn) {
    const h = acquireAll(specs);
    try {
        return fn(h);
    } finally {
        h.release();
    }
}
