// The ONLY module that launches the engine. Everything is
// asynchronous, cancellable and time-limited: nothing here may block the Shell.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {redact} from '../shared/redact.js';
import {_, fmt} from './format.js';

export const SCHEMA_VERSION = 1;

const TIMEOUTS_S = {list: 60, switch: 45, add: 30, status: 15, default: 15, login: 330};

export class EngineError extends Error {
    constructor(kind, message, extra = {}) {
        super(redact(message, 300));
        this.kind = kind;
        this.extra = extra;
    }
}

/** Parse the engine's single JSON object (last stdout line). */
export function parseEngineOutput(stdout) {
    const lines = String(stdout ?? '').trim().split('\n').filter(Boolean);
    let obj;
    try {
        obj = JSON.parse(lines[lines.length - 1]);
    } catch {
        throw new EngineError('bad-output', _('The Claude Account Switcher engine returned an unreadable answer.'));
    }
    if (obj?.schemaVersion !== SCHEMA_VERSION)
        throw new EngineError('schema', fmt(_('Incompatible engine version (schema %s).'), obj?.schemaVersion));
    if (obj.error)
        throw new EngineError(obj.error.kind ?? 'internal', obj.error.message ?? '', obj.error);
    return obj;
}

export class EngineClient {
    /**
     * @param {string} enginePath absolute path of engine/main.js
     * @param {Gio.Settings} settings
     */
    constructor(enginePath, settings) {
        this._enginePath = enginePath;
        this._settings = settings;
        this._running = new Set();
        this._destroyed = false;
    }

    _argv(args) {
        const gjs = GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs';
        const argv = [gjs, '-m', this._enginePath, ...args, '--json'];
        const claude = this._settings.get_string('claude-path');
        if (claude)
            argv.push('--claude-path', claude);
        argv.push('--refresh-strategy', this._settings.get_string('refresh-strategy'));
        argv.push('--active-interval', String(this._settings.get_uint('refresh-interval')));
        return argv;
    }

    _spawn(args) {
        if (this._destroyed)
            throw new EngineError('destroyed', _('Claude Account Switcher was disabled.'));
        return Gio.Subprocess.new(this._argv(args),
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    }

    /**
     * Run one engine command and resolve with its JSON object.
     * @param {string[]} args
     * @param {{timeoutS?: number, detach?: boolean}} [o] detach: on destroy,
     *   let the process finish (a switch is transactional) instead of killing it
     */
    run(args, {timeoutS, detach = false} = {}) {
        const limit = timeoutS ?? TIMEOUTS_S[args[0]] ?? TIMEOUTS_S.default;
        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = this._spawn(args);
            } catch (e) {
                reject(e instanceof EngineError ? e : new EngineError('spawn', fmt(_('Could not start gjs: %s'), e.message)));
                return;
            }
            const cancellable = new Gio.Cancellable();
            const entry = {proc, cancellable, detach};
            this._running.add(entry);
            let timedOut = false;
            const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, limit, () => {
                timedOut = true;
                cancellable.cancel();
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            proc.communicate_utf8_async(null, cancellable, (p, res) => {
                this._running.delete(entry);
                if (!timedOut)
                    GLib.source_remove(timer);
                let stdout = '';
                try {
                    [, stdout] = p.communicate_utf8_finish(res);
                } catch (e) {
                    reject(timedOut
                        ? new EngineError('timeout', _('The Claude Account Switcher engine did not answer in time.'))
                        : new EngineError('cancelled', redact(e.message, 200)));
                    return;
                }
                try {
                    resolve(parseEngineOutput(stdout));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    list({cached = false, force = false} = {}) {
        return this.run(['list', ...cached ? ['--cached'] : [], ...force ? ['--force'] : []]);
    }

    status() {
        return this.run(['status']);
    }

    switchTo(number) {
        return this.run(['switch', String(number)], {detach: true});
    }

    switchBest() {
        return this.run(['switch', '--best'], {detach: true});
    }

    addCurrent() {
        return this.run(['add', '--current']);
    }

    remove(number) {
        return this.run(['remove', String(number)]);
    }

    alias(number, alias) {
        return this.run(alias ? ['alias', String(number), alias] : ['alias', String(number), '--unset']);
    }

    setDisabled(number, disabled) {
        return this.run([disabled ? 'disable' : 'enable', String(number)]);
    }

    doctor() {
        return this.run(['doctor'], {timeoutS: 40});
    }

    /**
     * Isolated browser login. Events arrive as JSON lines.
     * @param {{activate: boolean, onEvent: (ev: object) => void}} o
     * @returns {{promise: Promise<object>, cancel: () => void}}
     */
    login({activate, onEvent}) {
        const proc = this._spawn(['add', '--login', ...activate ? ['--activate'] : []]);
        const cancellable = new Gio.Cancellable();
        const entry = {proc, cancellable, login: true};
        this._running.add(entry);
        const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true});
        let timedOut = false;
        const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUTS_S.login, () => {
            timedOut = true;
            proc.send_signal(15);
            return GLib.SOURCE_REMOVE;
        });
        const promise = new Promise((resolve, reject) => {
            let last = null;
            const readNext = () => {
                stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                    let line;
                    try {
                        [line] = s.read_line_finish_utf8(res);
                    } catch (e) {
                        finish(new EngineError('cancelled', redact(e.message, 200)));
                        return;
                    }
                    if (line === null) {
                        finish(null);
                        return;
                    }
                    try {
                        const ev = JSON.parse(line);
                        if (ev.schemaVersion !== SCHEMA_VERSION) {
                            finish(new EngineError('schema', _('Incompatible engine version.')));
                            return;
                        }
                        last = ev;
                        if (ev.event !== 'done' && ev.event !== 'error')
                            onEvent(ev);
                    } catch {
                        // ignore non-JSON lines
                    }
                    readNext();
                });
            };
            const finish = err => {
                this._running.delete(entry);
                if (!timedOut)
                    GLib.source_remove(timer);
                if (err)
                    reject(err);
                else if (last?.event === 'done')
                    resolve(last);
                else if (last?.error)
                    reject(new EngineError(last.error.kind, last.error.message, last.error));
                else
                    reject(new EngineError(timedOut ? 'timeout' : 'login-failed', _('The sign-in did not finish.')));
            };
            readNext();
        });
        return {promise, cancel: () => proc.send_signal(15)};
    }

    destroy() {
        this._destroyed = true;
        for (const e of this._running) {
            e.cancellable.cancel();
            if (e.login)
                e.proc.send_signal(15); // the engine stops claude and cleans its temp dir
            else if (!e.detach)
                e.proc.force_exit();
        }
        this._running.clear();
    }
}
