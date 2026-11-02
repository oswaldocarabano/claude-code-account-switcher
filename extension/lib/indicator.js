// Top-bar indicator and its menu. Rebuilds only what changed.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import {AccountCard} from './accountCard.js';
import {
    indicatorText, level, ago, accentFor, dataHash, fmt,
} from './format.js';

const INSTALL_HINT = 'sudo apt install gjs';

function label(text, style, extra = {}) {
    const l = new St.Label({text, style_class: style, ...extra});
    l.clutter_text.line_wrap = true;
    return l;
}

function pill(text, onClick, style = 'cas-pill-button') {
    const b = new St.Button({label: text, style_class: style, can_focus: true, x_align: Clutter.ActorAlign.CENTER});
    b.connect('clicked', onClick);
    return b;
}

/** A non-reactive menu item hosting arbitrary content. */
function holder(child) {
    // reactive (so the theme does not dim it as insensitive) but inert.
    const item = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false});
    item.add_style_class_name('cas-holder');
    item.add_child(child);
    return item;
}

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension, store, settings) {
        super._init(0.5, 'Claude Account Switcher', false);
        this._ext = extension;
        this._store = store;
        this._settings = settings;
        this._ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._cards = new Map();
        this._lastHash = null;
        this._ids = [];

        // ---- panel box
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box cas-indicator-box'});
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/claude-accounts-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this._alert = new St.Icon({icon_name: 'dialog-warning-symbolic', style_class: 'cas-indicator-alert', visible: false, y_align: Clutter.ActorAlign.START});
        this._name = new St.Label({style_class: 'cas-indicator-name', y_align: Clutter.ActorAlign.CENTER});
        this._sep = new St.Label({text: '·', style_class: 'cas-indicator-sep', y_align: Clutter.ActorAlign.CENTER});
        this._pct = new St.Label({style_class: 'cas-indicator-pct', y_align: Clutter.ActorAlign.CENTER});
        for (const w of [this._icon, this._alert, this._name, this._sep, this._pct])
            box.add_child(w);
        this.add_child(box);

        // ---- menu
        this.menu.box.add_style_class_name('cas-menu');
        this._buildHeader();
        this._banners = new PopupMenu.PopupMenuSection();
        this._banners.actor.add_style_class_name('cas-banners');
        this.menu.addMenuItem(this._banners);

        this._cardsSection = new PopupMenu.PopupMenuSection();
        this._cardsSection.actor.add_style_class_name('cas-cards');
        this._scroll = new St.ScrollView({
            style_class: 'cas-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._scroll.set_child(this._cardsSection.actor);
        this._cardsHolder = new PopupMenu.PopupMenuSection();
        this._cardsHolder.actor.add_child(this._scroll);
        this.menu.addMenuItem(this._cardsHolder);
        this._cardsSection._getTopMenu = () => this.menu;

        this._stateSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._stateSection);

        this._buildFooter();

        // ---- signals
        this._ids.push([store, store.connect('changed', () => this._sync())]);
        this._ids.push([this.menu, this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._store.menuOpened();
                this._sync(true);
            }
        })]);
        for (const key of ['indicator-format', 'color-warn', 'color-crit', 'show-seven-day'])
            this._ids.push([settings, settings.connect(`changed::${key}`, () => this._sync(true))]);
        this._ids.push([this._ifaceSettings, this._ifaceSettings.connect('changed::gtk-theme', () => this._sync(true))]);
        this._sync(true);
    }

    // ------------------------------------------------------------ building

    _buildHeader() {
        const row = new St.BoxLayout({style_class: 'cas-header', x_expand: true});
        const titles = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        titles.add_child(new St.Label({text: _('Claude accounts'), style_class: 'cas-header-title'}));
        this._headerSub = new St.Label({style_class: 'cas-header-sub'});
        titles.add_child(this._headerSub);
        row.add_child(titles);

        this._refreshSpinner = new Animation.Spinner(16, {animate: true, hideOnStop: true});
        row.add_child(this._refreshSpinner);
        this._refreshButton = new St.Button({
            style_class: 'button cas-icon-button',
            child: new St.Icon({icon_name: 'view-refresh-symbolic'}),
            can_focus: true,
            accessible_name: _('Refresh'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._refreshButton.connect('clicked', () => this._store.refresh({force: true}));
        row.add_child(this._refreshButton);
        this.menu.addMenuItem(holder(row));
    }

    _buildFooter() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._bestItem = new PopupMenu.PopupImageMenuItem(_('Switch to the one with most quota left'), 'media-playlist-shuffle-symbolic');
        this._bestItem.connect('activate', () => this._store.switchBest());
        this.menu.addMenuItem(this._bestItem);

        const add = new PopupMenu.PopupSubMenuMenuItem(_('Add account'), true);
        add.icon.icon_name = 'list-add-symbolic';
        add.menu.addAction(_('Sign in with another account…'), () => this._startLogin());
        this._saveCurrentItem = add.menu.addAction(_('Save the current session'), () => this._store.addCurrent());
        this.menu.addMenuItem(add);

        const more = new PopupMenu.PopupSubMenuMenuItem(_('More'), true);
        more.icon.icon_name = 'view-more-symbolic';
        more.menu.addAction(_('Diagnostics'), () => this._runDoctor());
        more.menu.addAction(_('Open backups folder'), () => {
            const dir = `${GLib.get_user_data_dir()}/claude-accounts/stash`;
            try {
                Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(dir, null), null);
            } catch (e) {
                this._store.emit('notify', {title: _('Could not open the folder'), body: e.message, kind: 'error'});
            }
        });
        more.menu.addAction(_('Preferences'), () => this._ext.openPreferences());
        this.menu.addMenuItem(more);

        const foot = new St.BoxLayout({style_class: 'cas-footer', x_expand: true});
        this._footer = new St.Label({style_class: 'cas-footer-text'});
        foot.add_child(this._footer);
        this.menu.addMenuItem(holder(foot));
    }

    _startLogin(forAccount = null) {
        this._store.startLogin({forAccount});
    }

    async _runDoctor() {
        try {
            const r = await this._store._client.doctor();
            const bad = r.checks.filter(c => !c.ok).map(c => c.id);
            this._store.emit('notify', {
                title: _('Claude Account Switcher diagnostics'),
                body: bad.length ? fmt(_('Checks with problems: %s'), bad.join(', ')) : _('Everything looks fine.'),
                kind: bad.length ? 'warn' : 'info',
            });
        } catch (e) {
            this._store.emit('notify', {title: _('Claude Account Switcher diagnostics'), body: e.message, kind: 'error'});
        }
    }

    // ------------------------------------------------------------ sync

    get _accent() {
        return accentFor(this._ifaceSettings.get_string('gtk-theme'));
    }

    _sync(force = false) {
        const s = this._store;
        const data = s.data;
        const active = s.activeAccount;

        // panel label
        const fmtKey = this._settings.get_string('indicator-format');
        const t = indicatorText(fmtKey, active) || {name: '', pct: ''};
        this._name.text = t.name;
        this._name.visible = Boolean(t.name);
        this._pct.text = t.pct;
        this._pct.visible = Boolean(t.pct);
        this._sep.visible = this._name.visible && this._pct.visible;
        const lv = level(active?.usage?.fiveHour?.pct, this._settings.get_uint('color-warn'), this._settings.get_uint('color-crit'));
        for (const c of ['ok', 'warn', 'crit', 'none'])
            this._pct.remove_style_class_name(`cas-${c}`);
        this._pct.add_style_class_name(`cas-${lv}`);
        const capture = data?.active?.capture;
        this._alert.visible = Boolean(s.error) || ['unmanaged', 'wiped', 'foreign', 'alien'].includes(capture) ||
            Boolean(active && active.state === 'needs-login');
        this.accessible_name = active
            ? fmt(_('Claude account %s, 5-hour usage %s'), active.email, t.pct || '–')
            : _('Claude accounts');

        // icon pulse while switching
        if (s.op === 'switch' && !this._pulsing) {
            this._pulsing = true;
            this._icon.ease({
                opacity: 90, duration: 600, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                repeatCount: -1, autoReverse: true,
            });
        } else if (s.op !== 'switch' && this._pulsing) {
            this._pulsing = false;
            this._icon.remove_all_transitions();
            this._icon.ease({opacity: 255, duration: 200});
        }

        // header + footer
        const n = data?.accounts?.length ?? 0;
        this._headerSub.text = data ? fmt(ngettext('%d account', '%d accounts', n), n) : '';
        if (s.op === 'refresh')
            this._refreshSpinner.play();
        else
            this._refreshSpinner.stop();
        this._refreshButton.visible = s.op !== 'refresh';
        if (s.op === 'refresh' && !s.lastRefresh)
            this._footer.text = _('Updating…');
        else if (s.lastRefresh)
            this._footer.text = fmt(_('Updated %s'), ago(new Date(s.lastRefresh).toISOString()));
        else
            this._footer.text = '';
        const switchable = (data?.accounts ?? []).filter(a => !a.active && !a.disabled && a.state !== 'needs-login');
        this._bestItem.setSensitive(!s.busy && switchable.length > 0);
        this._saveCurrentItem.setSensitive(!s.busy);

        if (!this.menu.isOpen && !force)
            return;
        this._syncBanners();
        this._syncBody(force);
    }

    _syncBanners() {
        this._banners.removeAll();
        const s = this._store;
        const data = s.data;
        const banner = (kind, icon, text, action = null) => {
            const b = new St.BoxLayout({style_class: `cas-banner cas-banner-${kind}`, x_expand: true});
            b.add_child(new St.Icon({icon_name: icon, y_align: Clutter.ActorAlign.CENTER}));
            b.add_child(label(text, 'cas-banner-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            if (action)
                b.add_child(pill(action[0], action[1], 'cas-banner-button'));
            this._banners.addMenuItem(holder(b));
        };
        if (s.error && s.error.kind !== 'cancelled') {
            banner('error', 'dialog-error-symbolic', s.error.message || _('Unknown error'),
                [_('Retry'), () => s.refresh({force: true})]);
        }
        const cap = data?.active?.capture;
        const hasAccounts = (data?.accounts?.length ?? 0) > 0;
        if (cap === 'unmanaged' && hasAccounts) {
            banner('warn', 'dialog-warning-symbolic',
                fmt(_('Signed in as %s, not saved'), data.active.email ?? '?'),
                [_('Save'), () => s.addCurrent()]);
        } else if (cap === 'wiped') {
            banner('error', 'dialog-error-symbolic',
                fmt(_('Claude Code lost the session of %s'), data.active.email ?? '?'),
                [_('Sign in again'), () => this._startLogin()]);
        } else if (cap === 'foreign' || cap === 'alien') {
            banner('warn', 'dialog-warning-symbolic', _('The current session does not match its account; a backup was saved.'));
        }
        for (const w of s.lastWarnings ?? [])
            banner('info', 'dialog-information-symbolic', w);
        s.lastWarnings = [];
        if (data && data.sessions?.busy > 0 && s.op === 'switch')
            banner('info', 'dialog-information-symbolic', _('A Claude Code session is answering; it will use the new account on its next request.'));
        this._banners.actor.visible = this._banners.numMenuItems > 0;
    }

    _syncBody(force) {
        const s = this._store;
        const data = s.data;
        this._stateSection.removeAll();

        // login flow replaces the cards
        if (s.login) {
            this._cardsHolder.actor.hide();
            this._stateSection.addMenuItem(holder(this._loginView(s.login)));
            return;
        }
        if (!data) {
            this._cardsHolder.actor.hide();
            if (s.error?.kind === 'spawn') {
                this._stateSection.addMenuItem(holder(this._stateView('dialog-error-symbolic',
                    _('Claude Account Switcher needs gjs'), _('Install it with:'), INSTALL_HINT,
                    [[_('Copy command'), () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, INSTALL_HINT)]])));
            } else {
                const box = new St.BoxLayout({vertical: true, style_class: 'cas-state', x_expand: true});
                const sp = new Animation.Spinner(24, {animate: true});
                sp.x_align = Clutter.ActorAlign.CENTER;
                box.add_child(sp);
                sp.play();
                this._stateSection.addMenuItem(holder(box));
            }
            return;
        }
        if (!data.accounts.length) {
            this._cardsHolder.actor.hide();
            const live = data.active?.capture && !['none', 'wiped'].includes(data.active.capture);
            this._stateSection.addMenuItem(holder(live
                ? this._stateView('avatar-default-symbolic', _('Save your current account to start'),
                    fmt(_('Claude Code is signed in as %s.'), data.active.email ?? '?'), null,
                    [[_('Save'), () => s.addCurrent()], [_('Add another…'), () => this._startLogin()]])
                : this._stateView('avatar-default-symbolic', _('Sign in with your first account'),
                    _('Your browser opens the official Claude sign-in page.'), null,
                    [[_('Sign in…'), () => this._startLogin()]])));
            return;
        }

        this._cardsHolder.actor.show();
        const hash = dataHash([data.accounts, s.switching, s.busy, this._accent,
            this._settings.get_uint('color-warn'), this._settings.get_uint('color-crit'),
            this._settings.get_boolean('show-seven-day')]);
        if (hash === this._lastHash && !force)
            return;
        const animate = hash !== this._lastHash;
        this._lastHash = hash;

        const ctx = {
            warn: this._settings.get_uint('color-warn'),
            crit: this._settings.get_uint('color-crit'),
            showSevenDay: this._settings.get_boolean('show-seven-day'),
            accent: this._accent,
            animate,
        };
        const seen = new Set();
        data.accounts.forEach((a, i) => {
            seen.add(a.uuid);
            let card = this._cards.get(a.uuid);
            if (!card) {
                card = new AccountCard({
                    onActivate: acct => this._store.switchTo(acct.number),
                    onRenew: acct => this._startLogin(acct),
                });
                this._cards.set(a.uuid, card);
                this._cardsSection.addMenuItem(card, i);
            } else {
                this._cardsSection.moveMenuItem(card, i);
            }
            const switching = s.switching === a.number;
            card.update(a, {...ctx, switching, inert: s.busy && s.op === 'switch'});
        });
        for (const [uuid, card] of this._cards) {
            if (!seen.has(uuid)) {
                card.destroy();
                this._cards.delete(uuid);
            }
        }
    }

    _stateView(icon, title, text, code, buttons) {
        const box = new St.BoxLayout({vertical: true, style_class: 'cas-state', x_expand: true});
        box.add_child(new St.Icon({icon_name: icon, style_class: 'cas-state-icon', x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(label(title, 'cas-state-title', {x_align: Clutter.ActorAlign.CENTER}));
        if (text)
            box.add_child(label(text, 'cas-state-text', {x_align: Clutter.ActorAlign.CENTER}));
        if (code)
            box.add_child(new St.Label({text: code, style_class: 'cas-state-code', x_align: Clutter.ActorAlign.CENTER}));
        if (buttons?.length) {
            const row = new St.BoxLayout({style_class: 'cas-state-buttons', x_align: Clutter.ActorAlign.CENTER});
            for (const [t, fn] of buttons)
                row.add_child(pill(t, fn));
            box.add_child(row);
        }
        return box;
    }

    _loginView(login) {
        const s = this._store;
        if (login.phase === 'error') {
            return this._stateView('dialog-error-symbolic', _('Could not add the account'), login.message, null,
                [[_('Try again'), () => this._startLogin()], [_('Close'), () => s.dismissLoginError()]]);
        }
        const box = new St.BoxLayout({vertical: true, style_class: 'cas-state', x_expand: true});
        box.add_child(new St.Icon({icon_name: 'web-browser-symbolic', style_class: 'cas-state-icon', x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(label(login.forAccount ? fmt(_('Renew %s'), login.forAccount.email) : _('Add account'),
            'cas-state-title', {x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(label(_('Your browser opened. Sign in with the account you want to add.'),
            'cas-state-text', {x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(label(_('Your current session does not change.'),
            'cas-state-text', {x_align: Clutter.ActorAlign.CENTER}));

        const waiting = new St.BoxLayout({style_class: 'cas-state-buttons', x_align: Clutter.ActorAlign.CENTER});
        const sp = new Animation.Spinner(16, {animate: true});
        sp.play();
        waiting.add_child(sp);
        waiting.add_child(new St.Label({text: _('Waiting…'), y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(waiting);

        const row = new St.BoxLayout({style_class: 'cas-state-buttons', x_align: Clutter.ActorAlign.CENTER});
        if (login.url) {
            row.add_child(pill(_('Copy link'), () =>
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, login.url)));
        }
        row.add_child(pill(_('Cancel'), () => s.cancelLogin()));
        box.add_child(row);

        if (!login.forAccount) {
            const check = new St.Button({style_class: 'cas-check', can_focus: true, x_align: Clutter.ActorAlign.CENTER});
            const inner = new St.BoxLayout({style_class: 'cas-check'});
            inner.add_child(new St.Icon({
                icon_name: login.activate ? 'checkbox-checked-symbolic' : 'checkbox-symbolic',
                icon_size: 16,
            }));
            inner.add_child(new St.Label({text: _('Use it as soon as it is added'), y_align: Clutter.ActorAlign.CENTER}));
            check.set_child(inner);
            check.accessible_name = _('Use it as soon as it is added');
            check.connect('clicked', () => {
                this._settings.set_boolean('activate-after-login', !login.activate);
                login.activate = !login.activate; // applies to the next login; the running one keeps its choice
                this._sync(true);
            });
            box.add_child(check);
        }
        return box;
    }

    destroy() {
        for (const [obj, id] of this._ids)
            obj.disconnect(id);
        this._ids = [];
        this._icon.remove_all_transitions();
        this._cards.clear();
        this._ifaceSettings = null;
        super.destroy();
    }
});
