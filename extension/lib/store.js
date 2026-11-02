// State of the extension + scheduling. No St imports: it is
// unit-tested with plain gjs and a fake engine client.
//
// - One engine command at a time: refreshes are dropped while busy; switch and
//   add wait their turn (queue).
// - Refresh triggers: timer, menu opening (>30 s old), credential file change
//   (2 s debounce), after switch/add.
// - Threshold notification once per window (uuid + resetsAt).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export class Emitter {
    constructor() {
        this._handlers = new Map();
        this._nextId = 1;
    }

    connect(name, fn) {
        const id = this._nextId++;
        this._handlers.set(id, {name, fn});
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    emit(name, ...args) {
        for (const {name: n, fn} of [...this._handlers.values()]) {
            if (n === name) {
                try {
                    fn(this, ...args);
                } catch (e) {
                    console.error(`[ClaudeAccountSwitcher] handler for ${name} failed: ${e.message}`);
                }
            }
        }
    }
}

const MENU_STALE_MS = 30000;
const DEBOUNCE_MS = 2000;

export class Store extends Emitter {
    /**
     * @param {object} client EngineClient (or a fake in tests)
     * @param {Gio.Settings} settings
     * @param {{homeDir?: string, gettext?: Function, clock?: Function, timers?: boolean}} [o]
     */
    constructor(client, settings, {homeDir = GLib.get_home_dir(), gettext = s => s, clock = () => Date.now(), timers = true} = {}) {
        super();
        this._client = client;
        this._settings = settings;
        this._home = homeDir;
        this._ = gettext;
        this._clock = clock;
        this._useTimers = timers;
        this.data = null;
        this.error = null;
        this.busy = false;
        this.op = null;
        this.switching = null;
        this.lastRefresh = 0;
        this.login = null;
        this._queue = [];
        this._timerId = 0;
        this._debounceId = 0;
        this._monitor = null;
        this._monitorId = 0;
        this._settingsIds = [];
        this._warned = new Set();
        this._loginHandle = null;
        this._destroyed = false;
    }

    // ---------------------------------------------------------------- lifecycle

    start() {
        if (this._useTimers) {
            this._armTimer();
            this._settingsIds.push(this._settings.connect('changed::refresh-interval', () => this._armTimer()));
            this._watchCredentials();
        }
        this.refresh({cached: true}).then(() => this.refresh());
    }

    destroy() {
        this._destroyed = true;
        if (this._timerId)
            GLib.source_remove(this._timerId);
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._timerId = this._debounceId = 0;
        if (this._monitor) {
            this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
            this._monitor = null;
        }
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._loginHandle?.cancel();
        this._loginHandle = null;
        this._queue = [];
        this._handlers.clear();
    }

    _armTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        const s = Math.max(120, this._settings.get_uint('refresh-interval'));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, s, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _watchCredentials() {
        const file = Gio.File.new_for_path(`${this._home}/.claude/.credentials.json`);
        try {
            this._monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        } catch {
            return; // optional: the timer still refreshes
        }
        this._monitorId = this._monitor.connect('changed', () => this.credentialsChanged());
    }

    /** Debounced: Claude Code rewrites the file on /login and token renewal. */
    credentialsChanged() {
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceId = 0;
            this.refresh({cached: true});
            return GLib.SOURCE_REMOVE;
        });
    }

    menuOpened() {
        if (this._clock() - this.lastRefresh > MENU_STALE_MS)
            this.refresh({cached: true}).then(() => this.refresh());
    }

    _changed() {
        if (!this._destroyed)
            this.emit('changed');
    }

    _notify(title, body, kind = 'info') {
        if (!this._destroyed)
            this.emit('notify', {title, body, kind});
    }

    // ---------------------------------------------------------------- queue

    _drain() {
        if (this.busy || this._destroyed || !this._queue.length)
            return;
        const {op, fn, resolve} = this._queue.shift();
        this._run(op, fn).then(resolve);
    }

    async _run(op, fn) {
        this.busy = true;
        this.op = op;
        this._changed();
        let result = null;
        try {
            result = await fn();
        } catch (e) {
            result = {error: e};
        } finally {
            this.busy = false;
            this.op = null;
            this.switching = null;
            this._changed();
            this._drain();
        }
        return result;
    }

    _enqueue(op, fn) {
        return new Promise(resolve => {
            this._queue.push({op, fn, resolve});
            this._drain();
        });
    }

    // ---------------------------------------------------------------- operations

    /** Dropped while another command runs. */
    refresh({cached = false, force = false} = {}) {
        if (this.busy || this._destroyed)
            return Promise.resolve(null);
        return this._run('refresh', async () => {
            try {
                const data = await this._client.list({cached, force});
                this.data = data;
                this.error = null;
                this.lastRefresh = this._clock();
                this._checkThreshold();
            } catch (e) {
                if (e.kind === 'destroyed' || e.kind === 'cancelled')
                    return;
                this.error = e;
            }
        });
    }

    switchTo(number) {
        return this._enqueue('switch', () => {
            this.switching = number;
            this._changed();
            return this._afterSwitch(() => this._client.switchTo(number));
        });
    }

    switchBest() {
        return this._enqueue('switch', () => this._afterSwitch(() => this._client.switchBest()));
    }

    async _afterSwitch(call) {
        const _ = this._;
        try {
            const r = await call();
            if (r.switched) {
                if (this._settings.get_boolean('notify-on-switch')) {
                    if (r.verified === false)
                        this._notify(_('Account switched (not confirmed)'), _('Claude Code still reports another account. Check with /status.'), 'warn');
                    else
                        this._notify(_('Claude account: %s').replace('%s', r.to.email), _('Your conversations stay open; the next request uses this account.'));
                }
                this.lastWarnings = r.warnings ?? [];
            } else if (r.reason === 'no-candidate') {
                this._notify(_('Account not switched'), _('No other account is available.'), 'warn');
            }
            await this._listNow({cached: true});
            return r;
        } catch (e) {
            if (e.kind !== 'destroyed')
                this._notify(_('Account not switched'), this._errorText(e), 'error');
            await this._listNow({cached: true});
            return {error: e};
        }
    }

    addCurrent() {
        const _ = this._;
        return this._enqueue('add', async () => {
            try {
                const r = await this._client.addCurrent();
                this._notify(_('Account saved'), r.account.email);
                await this._listNow({cached: true});
                return r;
            } catch (e) {
                this._notify(_('Could not save the account'), this._errorText(e), 'error');
                return {error: e};
            }
        });
    }

    async _listNow(opts) {
        try {
            this.data = await this._client.list(opts);
            this.error = null;
            this.lastRefresh = this._clock();
        } catch (e) {
            this.error = e;
        }
    }

    /** Isolated browser login. Does not take the busy flag. */
    startLogin({activate = this._settings.get_boolean('activate-after-login'), forAccount = null} = {}) {
        if (this.login && this.login.phase !== 'error')
            return;
        const _ = this._;
        this.login = {phase: 'waiting', url: null, activate, forAccount};
        this._changed();
        try {
            this._loginHandle = this._client.login({
                activate,
                onEvent: ev => {
                    if (ev.event === 'auth-url' && this.login) {
                        this.login.url = ev.url;
                        this._changed();
                    }
                },
            });
        } catch (e) {
            this.login = {phase: 'error', message: this._errorText(e)};
            this._changed();
            return;
        }
        this._loginHandle.promise.then(r => {
            this._loginHandle = null;
            this.login = null;
            this._notify(r.renewed ? _('Account renewed') : _('Account saved'), r.account.email);
            this._changed();
            this.refresh({cached: true}).then(() => this.refresh());
        }).catch(e => {
            this._loginHandle = null;
            this.login = e.kind === 'cancelled' || this._destroyed ? null : {phase: 'error', message: this._errorText(e)};
            this._changed();
        });
    }

    cancelLogin() {
        if (this._loginHandle)
            this._loginHandle.cancel();
        else
            this.login = null;
        this._changed();
    }

    dismissLoginError() {
        this.login = null;
        this._changed();
    }

    // ---------------------------------------------------------------- helpers

    get activeAccount() {
        return this.data?.accounts?.find(a => a.active) ?? null;
    }

    _checkThreshold() {
        const limit = this._settings.get_uint('warn-threshold');
        const a = this.activeAccount;
        const w = a?.usage?.fiveHour;
        if (!limit || !w || w.estimated || w.pct < limit)
            return;
        const key = `${a.uuid}:${w.resetsAt}`;
        if (this._warned.has(key))
            return;
        this._warned.add(key);
        const _ = this._;
        const other = this.data.accounts
            .filter(x => !x.active && !x.disabled && x.state === 'ok' && x.usage?.fiveHour)
            .sort((x, y) => x.usage.fiveHour.pct - y.usage.fiveHour.pct)[0];
        let body = w.resetsAt ? _('Resets at %s.').replace('%s', this.formatClock?.(w.resetsAt) ?? w.resetsAt) : '';
        if (other)
            body += ` ${_('%s is at %d%%.').replace('%s', other.alias || other.email).replace('%d', Math.round(other.usage.fiveHour.pct)).replace('%%', '%')}`;
        this._notify(_('%s at %d%% (5 h)').replace('%s', a.alias || a.email.split('@')[0]).replace('%d', Math.round(w.pct)).replace('%%', '%'),
            body.trim(), 'warn');
    }

    _errorText(e) {
        const _ = this._;
        switch (e?.kind) {
        case 'needs-login':
            return _('This account needs to sign in again.');
        case 'lock-timeout':
            return _('Claude Code is renewing its credentials; try again in a few seconds.');
        case 'timeout':
            return _('The Claude Account Switcher engine did not answer in time.');
        case 'claude-not-found':
            return _('Claude Code (claude) was not found.');
        case 'schema':
            return _('The Claude Account Switcher engine is not compatible with this extension.');
        default:
            return e?.message || _('Unknown error');
        }
    }
}
