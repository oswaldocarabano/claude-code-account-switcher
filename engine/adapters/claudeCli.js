// The official CLI: `claude auth status|login` and `claude --version`.

import GLib from 'gi://GLib';
import {runSync} from './proc.js';

function isExecutable(path) {
    return Boolean(path) && GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) &&
        !GLib.file_test(path, GLib.FileTest.IS_DIR);
}

/** --claude-path, then ~/.local/bin/claude, then PATH. */
export function resolveClaude(explicit, paths) {
    if (explicit)
        return isExecutable(explicit) ? explicit : null;
    const local = `${paths.home}/.local/bin/claude`;
    if (isExecutable(local))
        return local;
    return GLib.find_program_in_path('claude');
}

export class ClaudeCli {
    constructor(path) {
        this.path = path;
    }

    get available() {
        return Boolean(this.path);
    }

    version() {
        if (!this.path)
            return null;
        const r = runSync([this.path, '--version'], {timeoutS: 10});
        return r.ok ? r.stdout.trim().split('\n')[0] : null;
    }

    /**
     * `claude auth status --json`. configDir null = the default (live) profile.
     * Never trust loggedIn alone: callers read the files afterwards.
     * @returns {object|null}
     */
    status(configDir, timeoutS = 20) {
        if (!this.path)
            return null;
        const opts = configDir
            ? {set: {CLAUDE_CONFIG_DIR: configDir}, timeoutS}
            : {unset: ['CLAUDE_CONFIG_DIR'], timeoutS};
        const r = runSync([this.path, 'auth', 'status', '--json'], opts);
        if (r.timedOut)
            return {timedOut: true};
        try {
            return JSON.parse(r.stdout);
        } catch {
            return null;
        }
    }
}
