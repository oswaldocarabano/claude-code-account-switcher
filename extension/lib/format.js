// Pure formatting helpers shared by the indicator, the cards and prefs.
// No St/Shell imports: this module is unit-tested with plain gjs.

import GLib from 'gi://GLib';

let gettextFn = s => s;
/** Translated string (identity outside the Shell). */
export const _ = s => gettextFn(s);
let ngettext = (s, p, n) => (n === 1 ? s : p);

/** printf-lite for translated strings: %d and %s in order (no String.prototype.format outside the Shell). */
export function fmt(template, ...args) {
    let i = 0;
    return template.replace(/%[ds]/g, () => String(args[i++]));
}

/** Inject the extension's gettext functions (tests keep the identity). */
export function setGettext(gettext, ngettextFn) {
    gettextFn = gettext;
    ngettext = ngettextFn ?? ngettext;
}

/** Alias, else the part of the email before "@", cut to `max` characters. */
export function shortName(account, max = 14) {
    const base = account?.alias || (account?.email ?? '').split('@')[0] || '?';
    return base.length > max ? `${base.slice(0, max - 1)}…` : base;
}

/** Title line of a card: alias or email. */
export function displayName(account) {
    return account?.alias || account?.email || '?';
}

export function pctText(pct) {
    return typeof pct === 'number' && Number.isFinite(pct) ? `${Math.round(pct)}%` : '–';
}

/** ok | warn | crit for a percentage and the configured thresholds. */
export function level(pct, warn = 70, crit = 90) {
    if (typeof pct !== 'number')
        return 'none';
    if (pct >= crit)
        return 'crit';
    if (pct >= warn)
        return 'warn';
    return 'ok';
}

function localDateTime(iso) {
    if (!iso)
        return null;
    const dt = GLib.DateTime.new_from_iso8601(iso, null);
    return dt ? dt.to_local() : null;
}

/** "19:40" if today, "6 nov" otherwise. */
export function resetClock(iso, nowMs = Date.now()) {
    const dt = localDateTime(iso);
    if (!dt)
        return '';
    const now = GLib.DateTime.new_from_unix_local(Math.floor(nowMs / 1000));
    if (dt.get_year() === now.get_year() && dt.get_day_of_year() === now.get_day_of_year())
        return dt.format('%H:%M');
    return dt.format('%-d %b').replace('.', '');
}

/** "3 h 45 min", "4 d 22 h", "12 min", "ahora". */
export function countdown(iso, nowMs = Date.now()) {
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t))
        return '';
    let s = Math.max(0, Math.floor((t - nowMs) / 1000));
    const d = Math.floor(s / 86400);
    s -= d * 86400;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    if (d > 0)
        return fmt(_('%d d %d h'), d, h);
    if (h > 0)
        return fmt(_('%d h %d min'), h, m);
    if (m > 0)
        return fmt(_('%d min'), m);
    return _('now');
}

/** "hace 1 min" style relative time for the footer and stale data. */
export function ago(iso, nowMs = Date.now()) {
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t))
        return _('never');
    const m = Math.max(0, Math.round((nowMs - t) / 60000));
    if (m < 1)
        return _('just now');
    if (m < 60)
        return fmt(ngettext('%d min ago', '%d min ago', m), m);
    const h = Math.round(m / 60);
    if (h < 48)
        return fmt(ngettext('%d h ago', '%d h ago', h), h);
    const days = Math.round(h / 24);
    return fmt(ngettext('%d day ago', '%d days ago', days), days);
}

/** Days until an ISO date (can be negative). */
export function daysUntil(iso, nowMs = Date.now()) {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? (t - nowMs) / 86400e3 : null;
}

/** Panel label for the configured format. */
export function indicatorText(format, account) {
    if (!account)
        return '';
    const name = shortName(account);
    const pct = account.usage?.fiveHour ? pctText(account.usage.fiveHour.pct) : null;
    switch (format) {
    case 'usage':
        return {name: '', pct: pct ?? '–'};
    case 'name':
        return {name, pct: ''};
    case 'icon':
        return {name: '', pct: ''};
    default:
        return {name, pct: pct ?? ''};
    }
}

/** Money with two decimals and the currency code: "12,30 / 50 USD". */
export function moneyText(spend) {
    if (!spend)
        return '';
    const money = v => (typeof v === 'number' ? v.toFixed(2).replace('.', _('.')) : '–');
    return spend.limit !== null && spend.limit !== undefined
        ? `${money(spend.used)} / ${money(spend.limit)} ${spend.currency}`
        : `${money(spend.used)} ${spend.currency}`;
}

const YARU_ACCENTS = {
    'Yaru': '#E95420', 'Yaru-bark': '#787859', 'Yaru-sage': '#657B69', 'Yaru-olive': '#4B8501',
    'Yaru-viridian': '#03875B', 'Yaru-prussiangreen': '#308280', 'Yaru-blue': '#0073E5',
    'Yaru-purple': '#7764D8', 'Yaru-magenta': '#B34CB3', 'Yaru-red': '#DA3450',
};

/** GNOME 47+ system accent colours (org.gnome.desktop.interface accent-color). */
const SYSTEM_ACCENTS = {
    blue: '#3584E4', teal: '#2190A4', green: '#3A944A', yellow: '#C88800', orange: '#ED5B00',
    red: '#E62D42', pink: '#D56199', purple: '#9141AC', slate: '#6F8396',
};

/**
 * Accent colour of the desktop: the GNOME 47+ accent-color setting when set,
 * else Ubuntu's Yaru variant, else Adwaita blue.
 */
export function accentFor(gtkTheme, systemAccent = null) {
    if (systemAccent && SYSTEM_ACCENTS[systemAccent] && !String(gtkTheme ?? '').startsWith('Yaru'))
        return SYSTEM_ACCENTS[systemAccent];
    const base = String(gtkTheme ?? '').replace(/-dark$/, '');
    return YARU_ACCENTS[base] ?? '#3584E4';
}

/** "#E95420" + alpha -> "rgba(233,84,32,0.12)". */
export function rgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Stable hash of a list result to skip redundant redraws. */
export function dataHash(obj) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, JSON.stringify(obj ?? null), -1);
}
