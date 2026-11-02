// Claude Account Switcher — Claude Code account switcher for the GNOME top bar.
// enable() creates everything; disable() undoes all of it.
// Nothing here reads or writes credentials: the engine does (CLAUDE.md).

import Gio from 'gi://Gio';
import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {EngineClient} from './lib/engineClient.js';
import {Store} from './lib/store.js';
import {Indicator} from './lib/indicator.js';
import {setGettext, resetClock} from './lib/format.js';
import {redact} from './shared/redact.js';

export default class ClaudeAccountSwitcherExtension extends Extension {
    enable() {
        setGettext(_, ngettext);
        this._settings = this.getSettings();
        this._client = new EngineClient(`${this.path}/engine/main.js`, this._settings);
        this._store = new Store(this._client, this._settings, {gettext: _});
        this._store.formatClock = iso => resetClock(iso);
        this._notifyId = this._store.connect('notify', (_s, n) => this._notify(n));
        this._indicator = new Indicator(this, this._store, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._store.start();
    }

    disable() {
        this._store?.destroy();
        this._indicator?.destroy();
        this._client?.destroy();
        this._source?.destroy();
        this._store = this._indicator = this._client = this._source = this._settings = null;
        this._notifyId = 0;
    }

    _getSource() {
        if (this._source)
            return this._source;
        this._source = new MessageTray.Source({
            title: 'Claude Account Switcher',
            icon: Gio.icon_new_for_string(`${this.path}/icons/claude-accounts-symbolic.svg`),
        });
        this._source.connect('destroy', () => {
            this._source = null;
        });
        Main.messageTray.add(this._source);
        return this._source;
    }

    _notify({title, body, kind}) {
        try {
            const source = this._getSource();
            const n = new MessageTray.Notification({
                source,
                title: redact(title, 120),
                body: redact(body ?? '', 300),
                isTransient: kind !== 'error',
            });
            source.addNotification(n);
        } catch (e) {
            console.warn(`[ClaudeAccountSwitcher] notification failed: ${redact(e.message)}`);
        }
    }
}
