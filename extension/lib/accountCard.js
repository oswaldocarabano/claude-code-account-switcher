// Account card. A PopupBaseMenuItem so keyboard navigation and
// focus come for free; activating it switches account WITHOUT closing the menu.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {UsageBar} from './usageBar.js';
import {
    displayName, pctText, level, resetClock, countdown, ago, daysUntil, moneyText, rgba, fmt,
} from './format.js';

const LOGIN_WARN_DAYS = 3;

const UsageRow = GObject.registerClass(
class UsageRow extends St.BoxLayout {
    _init(label) {
        super._init({style_class: 'cas-row', x_expand: true});
        this._label = new St.Label({text: label, style_class: 'cas-row-label', y_align: Clutter.ActorAlign.CENTER});
        this.bar = new UsageBar();
        this._pct = new St.Label({style_class: 'cas-row-pct', y_align: Clutter.ActorAlign.CENTER});
        this._reset = new St.Label({style_class: 'cas-row-reset', y_align: Clutter.ActorAlign.CENTER});
        this._pct.clutter_text.x_align = Clutter.ActorAlign.END;
        this._reset.clutter_text.x_align = Clutter.ActorAlign.END;
        this.add_child(this._label);
        this.add_child(this.bar);
        this.add_child(this._pct);
        this.add_child(this._reset);
        this._win = null;
    }

    /**
     * @param {object|null} win {pct, resetsAt, estimated}
     * @param {{warn: number, crit: number, hover: boolean, longName: string, animate: boolean}} o
     */
    update(win, {warn, crit, hover, longName, animate}) {
        this._win = win;
        const lv = win ? level(win.pct, warn, crit) : 'none';
        this.bar.setValue(win?.pct ?? 0, lv, animate);
        this._pct.text = win ? pctText(win.pct) : '–';
        for (const c of ['ok', 'warn', 'crit', 'none'])
            this._pct.remove_style_class_name(`cas-${c}`);
        this._pct.add_style_class_name(`cas-${lv}`);
        if (win?.estimated)
            this._pct.add_style_class_name('cas-estimated');
        else
            this._pct.remove_style_class_name('cas-estimated');
        this.setHover(hover);
        const when = win?.resetsAt ? fmt(_('resets at %s'), resetClock(win.resetsAt)) : '';
        this.bar.accessible_name = win
            ? `${longName}: ${fmt(_('%d percent'), Math.round(win.pct))}${when ? `, ${when}` : ''}`
            : `${longName}: ${_('no data')}`;
    }

    setHover(hover) {
        const w = this._win;
        if (!w)
            this._reset.text = '';
        else if (w.estimated)
            this._reset.text = _('reset');
        else if (w.resetsAt)
            this._reset.text = hover ? countdown(w.resetsAt) : `↻ ${resetClock(w.resetsAt)}`;
        else
            this._reset.text = '';
    }
});

export const AccountCard = GObject.registerClass(
class AccountCard extends PopupMenu.PopupBaseMenuItem {
    /**
     * @param {{onActivate: (acct: object) => void, onRenew: (acct: object) => void}} cb
     */
    _init(cb) {
        super._init({style_class: 'cas-card-item', can_focus: true});
        this._cb = cb;
        this._acct = null;
        this._ctx = null;

        this._card = new St.BoxLayout({vertical: true, style_class: 'cas-card', x_expand: true});
        this.add_child(this._card);

        const head = new St.BoxLayout({style_class: 'cas-card-head', x_expand: true});
        this._dot = new St.Label({style_class: 'cas-dot', y_align: Clutter.ActorAlign.CENTER});
        const titles = new St.BoxLayout({vertical: true, x_expand: true});
        this._title = new St.Label({style_class: 'cas-title'});
        this._title.clutter_text.ellipsize = 3; // PANGO_ELLIPSIZE_END
        this._subtitle = new St.Label({style_class: 'cas-subtitle'});
        this._subtitle.clutter_text.ellipsize = 3;
        titles.add_child(this._title);
        titles.add_child(this._subtitle);
        this._badge = new St.Label({style_class: 'cas-badge', y_align: Clutter.ActorAlign.CENTER});
        this._spinner = new Animation.Spinner(16, {animate: false, hideOnStop: true});
        head.add_child(this._dot);
        head.add_child(titles);
        head.add_child(this._spinner);
        head.add_child(this._badge);
        this._card.add_child(head);

        this._rows = new St.BoxLayout({vertical: true, style_class: 'cas-rows', x_expand: true});
        this._five = new UsageRow(_('5 h'));
        this._seven = new UsageRow(_('7 d'));
        this._rows.add_child(this._five);
        this._rows.add_child(this._seven);
        this._card.add_child(this._rows);

        this._notes = new St.BoxLayout({vertical: true});
        this._card.add_child(this._notes);

        this._action = new St.Button({style_class: 'cas-banner-button', x_align: Clutter.ActorAlign.START, can_focus: true});
        this._action.connect('clicked', () => this._cb.onRenew(this._acct));
        this._card.add_child(this._action);

        this.connect('notify::hover', () => {
            this._five.setHover(this.hover);
            this._seven.setHover(this.hover);
        });
    }

    /** Switching never closes the menu. */
    activate(_event) {
        if (this._acct && !this._acct.active && this.reactive)
            this._cb.onActivate(this._acct);
    }

    /**
     * @param {object} a account from `claude-accounts list`
     * @param {{warn: number, crit: number, showSevenDay: boolean, accent: string,
     *          switching: boolean, inert: boolean, animate: boolean}} ctx
     */
    update(a, ctx) {
        this._acct = a;
        this._ctx = ctx;
        const needsLogin = a.state === 'needs-login';

        this._dot.text = a.active ? '●' : '○';
        this._title.text = displayName(a);
        let sub = '';
        if (a.alias)
            sub = a.email;
        else if (!a.isPersonalOrg)
            sub = a.orgName;
        this._subtitle.text = sub;
        this._subtitle.visible = Boolean(sub);

        // badge
        for (const c of ['cas-badge-active', 'cas-badge-warn', 'cas-badge-error'])
            this._badge.remove_style_class_name(c);
        this._badge.set_style(null);
        if (a.active) {
            this._badge.text = _('ACTIVE');
            this._badge.add_style_class_name('cas-badge-active');
            this._badge.set_style(`background-color: ${ctx.accent};`);
        } else if (needsLogin) {
            this._badge.text = _('SIGN IN');
            this._badge.add_style_class_name('cas-badge-error');
        } else if (a.disabled) {
            this._badge.text = _('OUT OF ROTATION');
        } else {
            this._badge.text = '';
        }
        this._badge.visible = Boolean(this._badge.text) && !ctx.switching;
        if (ctx.switching)
            this._spinner.play();
        else
            this._spinner.stop();

        // active highlight from the desktop accent
        if (a.active) {
            this._card.add_style_class_name('cas-card-active');
            this._card.set_style(`background-color: ${rgba(ctx.accent, 0.14)}; border-left-color: ${ctx.accent};`);
        } else {
            this._card.remove_style_class_name('cas-card-active');
            this._card.set_style(null);
        }

        // bars
        this._rows.visible = !needsLogin;
        const stale = Boolean(a.usageError) && Boolean(a.usage);
        if (stale)
            this._rows.add_style_class_name('cas-stale');
        else
            this._rows.remove_style_class_name('cas-stale');
        const common = {warn: ctx.warn, crit: ctx.crit, hover: this.hover, animate: ctx.animate};
        this._five.update(a.usage?.fiveHour ?? null, {...common, longName: _('5-hour usage')});
        this._seven.update(a.usage?.sevenDay ?? null, {...common, longName: _('7-day usage')});
        this._seven.visible = ctx.showSevenDay;

        // notes
        this._notes.destroy_all_children();
        const note = (text, kind = '') => {
            const l = new St.Label({text, style_class: `cas-note${kind ? ` cas-note-${kind}` : ''}`});
            l.clutter_text.line_wrap = true;
            this._notes.add_child(l);
        };
        if (needsLogin) {
            note(_('⚠ The session of this account expired: sign in again.'), 'error');
        } else {
            for (const s of a.usage?.scoped ?? []) {
                if (s.pct >= 50)
                    note(`${s.name}  ${pctText(s.pct)}`, {crit: 'error', warn: 'warn'}[level(s.pct, ctx.warn, ctx.crit)] ?? '');
            }
            if (a.usage?.spend)
                note(`${_('Extra')}  ${moneyText(a.usage.spend)}`);
            if (stale) {
                note(a.usageError === 'http-429'
                    ? fmt(_('Query limit reached; data from %s'), ago(a.usageFetchedAt))
                    : fmt(_('Data from %s'), ago(a.usageFetchedAt)));
            } else if (!a.usage && a.usageError) {
                note(_('Usage not available right now'));
            } else if (!a.usage) {
                note(_('Usage not read yet'));
            }
            const days = daysUntil(a.loginExpiresAt);
            if (days !== null && days < LOGIN_WARN_DAYS)
                note(fmt(_('Session expires on %s'), resetClock(a.loginExpiresAt)), 'warn');
            if (a.state === 'unverified')
                note(_('Last copy not confirmed (a backup exists)'));
        }
        this._notes.visible = this._notes.get_n_children() > 0;

        const days = daysUntil(a.loginExpiresAt);
        const renew = needsLogin || (days !== null && days < LOGIN_WARN_DAYS);
        this._action.label = needsLogin ? _('Sign in') : _('Renew');
        this._action.visible = renew;

        // inert while another account is switching
        // the switching card stays reactive so the theme does not grey it out
        this.reactive = !ctx.inert || ctx.switching;
        this.can_focus = !ctx.inert;
        if (ctx.inert && !ctx.switching)
            this._card.add_style_class_name('cas-card-inert');
        else
            this._card.remove_style_class_name('cas-card-inert');

        this.accessible_name = `${displayName(a)}${a.active ? `, ${_('active')}` : ''}`;
    }
});
