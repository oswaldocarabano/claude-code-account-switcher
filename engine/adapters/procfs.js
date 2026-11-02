// /proc helpers: is a pid alive, and is it still the same process (procStart).

import GLib from 'gi://GLib';
import {readText} from './atomicFile.js';

/** Field 22 of /proc/<pid>/stat: start time in clock ticks since boot. */
export function procStart(pid) {
    let stat;
    try {
        stat = readText(`/proc/${pid}/stat`);
    } catch {
        return null;
    }
    if (!stat)
        return null;
    // comm (field 2) may contain spaces/parens: split after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19] ?? null; // fields 3.. -> index 0 is field 3, so field 22 is index 19
}

/**
 * @param {number} pid
 * @param {string|number|null} [expectedStart] procStart recorded with the pid
 */
export function isAlive(pid, expectedStart = null) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    if (!GLib.file_test(`/proc/${pid}`, GLib.FileTest.IS_DIR))
        return false;
    if (expectedStart === null || expectedStart === undefined || expectedStart === '')
        return true;
    const now = procStart(pid);
    // Only comparable if it looks like Linux ticks.
    if (now === null || !/^\d+$/.test(String(expectedStart)))
        return true;
    return String(now) === String(expectedStart);
}

export function selfPid() {
    const s = readText('/proc/self/stat');
    return Number(s.slice(0, s.indexOf(' ')));
}
