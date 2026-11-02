// Engine log: ~/.local/state/claude-accounts/claude-accounts.log (0600, 1 MB × 3). Lines carry
// account numbers, never emails or tokens (pasteable into issues).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {redact} from '../../shared/redact.js';
import {ensureDir, setMode, move, exists} from './atomicFile.js';

const MAX_BYTES = 1024 * 1024;
const KEEP = 3;

export class Log {
    constructor(paths, command) {
        this.paths = paths;
        this.command = command;
        this.debug = GLib.getenv('CLAUDE_ACCOUNTS_DEBUG') === '1';
    }

    _rotate() {
        const f = this.paths.logFile;
        try {
            const size = Gio.File.new_for_path(f).query_info('standard::size', 0, null).get_size();
            if (size < MAX_BYTES)
                return;
        } catch {
            return;
        }
        for (let i = KEEP - 1; i >= 1; i--) {
            const src = i === 1 ? f : `${f}.${i - 1}`;
            if (exists(src))
                move(src, `${f}.${i}`);
        }
    }

    write(level, msg) {
        if (level === 'debug' && !this.debug)
            return;
        try {
            ensureDir(this.paths.stateDir);
            this._rotate();
            const line = `${new Date().toISOString()} ${level} [${this.command}] ${redact(msg, 500)}\n`;
            const file = Gio.File.new_for_path(this.paths.logFile);
            const s = file.append_to(Gio.FileCreateFlags.PRIVATE, null);
            s.write_all(new TextEncoder().encode(line), null);
            s.close(null);
            setMode(this.paths.logFile, 0o600);
        } catch {
            // logging must never break an operation
        }
    }

    info(msg) {
        this.write('info', msg);
    }

    warn(msg) {
        this.write('warn', msg);
    }

    error(msg) {
        this.write('error', msg);
    }

    dbg(msg) {
        this.write('debug', msg);
    }
}
