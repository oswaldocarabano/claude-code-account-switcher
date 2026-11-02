// File primitives: coherent reads and atomic 0600 writes.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {EngineError} from '../lib/errors.js';
import {_, fmt} from '../lib/i18n.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** @returns {string|null} null if the file does not exist */
export function readText(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return decoder.decode(bytes);
    } catch (e) {
        if (e.matches?.(GLib.FileError, GLib.FileError.NOENT))
            return null;
        throw new EngineError('io', fmt(_('Could not read %s: %s'), GLib.path_get_basename(path), e.message));
    }
}

export function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

/** Follow a symlink chain so the write lands on the real file (#192 of claude-swap). */
export function resolveSymlinks(path) {
    let p = path;
    for (let i = 0; i < 40; i++) {
        if (!GLib.file_test(p, GLib.FileTest.IS_SYMLINK))
            return p;
        const target = GLib.file_read_link(p);
        p = GLib.path_is_absolute(target)
            ? target
            : GLib.canonicalize_filename(target, GLib.path_get_dirname(p));
    }
    throw new EngineError('io', fmt(_('Too many symbolic links: %s'), GLib.path_get_basename(path)));
}

/** JSON.stringify that refuses NaN/Infinity (Claude Code cannot parse them). */
export function stringifyStrict(value) {
    return `${JSON.stringify(value, (_k, v) => {
        if (typeof v === 'number' && !Number.isFinite(v))
            throw new EngineError('internal', _('Tried to write an invalid number to JSON'));
        return v;
    }, 2)}\n`;
}

/**
 * Atomic write: temp file in the same directory, created 0600, fsync, rename.
 */
export function writeAtomic(path, text, mode = 0o600) {
    const target = resolveSymlinks(path);
    ensureDir(GLib.path_get_dirname(target), null);
    try {
        GLib.file_set_contents_full(target, encoder.encode(text),
            GLib.FileSetContentsFlags.CONSISTENT | GLib.FileSetContentsFlags.DURABLE, mode);
    } catch (e) {
        throw new EngineError('io', fmt(_('Could not write %s: %s'), GLib.path_get_basename(path), e.message));
    }
}

export function writeJson(path, value) {
    writeAtomic(path, stringifyStrict(value));
}

/** mkdir -p; if mode is given the leaf directory is (re)set to it. */
export function ensureDir(path, mode = 0o700) {
    if (GLib.mkdir_with_parents(path, mode ?? 0o755) !== 0)
        throw new EngineError('io', fmt(_('Could not create %s'), path));
    if (mode !== null)
        setMode(path, mode);
}

export function setMode(path, mode) {
    try {
        Gio.File.new_for_path(path).set_attribute_uint32('unix::mode', mode,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch {
        // best effort
    }
}

export function modeOf(path) {
    try {
        return Gio.File.new_for_path(path)
            .query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
            .get_attribute_uint32('unix::mode') & 0o777;
    } catch {
        return null;
    }
}

export function listDir(path) {
    const out = [];
    try {
        const en = Gio.File.new_for_path(path).enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = en.next_file(null)))
            out.push(info.get_name());
        en.close(null);
    } catch {
        // missing directory -> empty
    }
    return out.sort();
}

export function removeFile(path) {
    try {
        Gio.File.new_for_path(path).delete(null);
        return true;
    } catch {
        return false;
    }
}

/** rm -rf for our own temp directories (never used on Claude Code's files). */
export function removeTree(path) {
    const f = Gio.File.new_for_path(path);
    if (GLib.file_test(path, GLib.FileTest.IS_DIR) && !GLib.file_test(path, GLib.FileTest.IS_SYMLINK)) {
        for (const name of listDir(path))
            removeTree(`${path}/${name}`);
    }
    try {
        f.delete(null);
    } catch {
        // already gone
    }
}

/** rename(2); both paths must be on the same filesystem. */
export function move(src, dst) {
    try {
        Gio.File.new_for_path(src).move(Gio.File.new_for_path(dst), Gio.FileCopyFlags.NOFOLLOW_SYMLINKS, null, null);
    } catch (e) {
        throw new EngineError('io', fmt(_('Could not move %s: %s'), GLib.path_get_basename(src), e.message));
    }
}

export function mtimeMs(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info('time::modified,time::modified-usec',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        return info.get_attribute_uint64('time::modified') * 1000 +
            Math.floor(info.get_attribute_uint32('time::modified-usec') / 1000);
    } catch {
        return null;
    }
}

export function touch(path, nowMs = Date.now()) {
    try {
        const info = new Gio.FileInfo();
        info.set_attribute_uint64('time::modified', Math.floor(nowMs / 1000));
        info.set_attribute_uint32('time::modified-usec', (nowMs % 1000) * 1000);
        Gio.File.new_for_path(path).set_attributes_from_info(info,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        return true;
    } catch {
        return false;
    }
}
