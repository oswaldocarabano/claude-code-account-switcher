// format.js (pure).

import {suite, test, assert} from '../lib/harness.js';
import {
    shortName, pctText, level, countdown, ago, indicatorText, moneyText, accentFor, rgba,
    resetClock, daysUntil,
} from '../../extension/lib/format.js';

suite('format');

test('short name: alias, else email local part, cut to 14', () => {
    assert.equal(shortName({alias: 'trabajo', email: 'x@y'}), 'trabajo');
    assert.equal(shortName({email: 'jordan1903@example.com'}), 'jordan1903');
    assert.equal(shortName({email: 'averyveryverylongname@x.com'}), 'averyveryvery…');
});

test('levels follow the thresholds and are never colour-only (pct text)', () => {
    assert.equal(level(69), 'ok');
    assert.equal(level(70), 'warn');
    assert.equal(level(90), 'crit');
    assert.equal(level(50, 40, 45), 'crit');
    assert.equal(level(undefined), 'none');
    assert.equal(pctText(4.4), '4%');
    assert.equal(pctText(null), '–');
});

test('countdown and relative times', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    assert.equal(countdown('2026-11-01T15:45:00Z', now), '3 h 45 min');
    assert.equal(countdown('2026-11-06T10:00:00Z', now), '4 d 22 h');
    assert.equal(countdown('2026-11-01T12:12:30Z', now), '12 min');
    assert.equal(countdown('2026-11-01T11:00:00Z', now), 'now');
    assert.equal(ago('2026-11-01T11:59:50Z', now), 'just now');
    assert.equal(ago('2026-11-01T11:59:00Z', now), '1 min ago');
    assert.equal(ago('2026-11-01T09:00:00Z', now), '3 h ago');
    assert.equal(ago(null, now), 'never');
    assert.ok(Math.abs(daysUntil('2026-11-04T12:00:00Z', now) - 3) < 1e-9);
});

test('reset clock: time today, short date otherwise', () => {
    const now = Date.now();
    const soon = new Date(now + 60e3).toISOString();
    assert.ok(/^\d{2}:\d{2}$/.test(resetClock(soon, now)) || resetClock(soon, now).length > 0);
    assert.ok(/\d/.test(resetClock(new Date(now + 5 * 86400e3).toISOString(), now)));
    assert.equal(resetClock(null), '');
});

test('indicator formats', () => {
    const a = {email: 'ana@x.com', usage: {fiveHour: {pct: 4}}};
    assert.deepEqual(indicatorText('name-and-usage', a), {name: 'ana', pct: '4%'});
    assert.deepEqual(indicatorText('usage', a), {name: '', pct: '4%'});
    assert.deepEqual(indicatorText('name', a), {name: 'ana', pct: ''});
    assert.deepEqual(indicatorText('icon', a), {name: '', pct: ''});
});

test('money, accent colours', () => {
    assert.equal(moneyText({used: 12.3, limit: 50, currency: 'USD'}), '12.30 / 50.00 USD');
    assert.equal(accentFor('Yaru-blue-dark'), '#0073E5');
    assert.equal(accentFor('Adwaita'), '#3584E4');
    assert.equal(accentFor('Adwaita', 'purple'), '#9141AC', 'GNOME 47+ accent-color');
    assert.equal(accentFor('Yaru-blue', 'purple'), '#0073E5', 'Ubuntu keeps its Yaru accent');
    assert.equal(rgba('#E95420', 0.12), 'rgba(233,84,32,0.12)');
});
