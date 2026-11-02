// Subprocess helper with timeout for the engine (which has no main loop of its
// own): spins a private GLib.MainLoop until the child exits or times out.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * @param {string[]} argv
 * @param {{set?: object, unset?: string[], timeoutS?: number, cwd?: string}} [o]
 * @returns {{ok: boolean, status: number|null, stdout: string, stderr: string, timedOut: boolean}}
 */
export function runSync(argv, {set = {}, unset = [], timeoutS = 20, cwd = null} = {}) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE,
    });
    for (const [k, v] of Object.entries(set))
        launcher.setenv(k, String(v), true);
    for (const k of unset)
        launcher.unsetenv(k);
    if (cwd)
        launcher.set_cwd(cwd);
    let proc;
    try {
        proc = launcher.spawnv(argv);
    } catch (e) {
        return {ok: false, status: null, stdout: '', stderr: e.message, timedOut: false, spawnFailed: true};
    }
    const loop = new GLib.MainLoop(null, false);
    const cancellable = new Gio.Cancellable();
    let stdout = '', stderr = '', timedOut = false;
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutS * 1000, () => {
        timedOut = true;
        cancellable.cancel();
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    proc.communicate_utf8_async('', cancellable, (p, res) => {
        try {
            [, stdout, stderr] = p.communicate_utf8_finish(res);
        } catch {
            // cancelled
        }
        loop.quit();
    });
    loop.run();
    if (!timedOut)
        GLib.source_remove(timer);
    proc.wait(null); // reap before asking for the exit status
    const status = proc.get_if_exited() ? proc.get_exit_status() : null;
    return {ok: !timedOut && status === 0, status, stdout: stdout ?? '', stderr: stderr ?? '', timedOut};
}
