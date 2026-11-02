// Pure domain tests.

import {suite, test, assert} from '../lib/harness.js';
import {
    SHARED_KEYS, refreshFp, isWiped, hasTokens, composeForActivation, stripShared,
    applyTokenResponse, loginExpiresAt, shapeError, isExpired,
} from '../../engine/domain/credential.js';
import {classifyLocal, resolveRotated, captureAction} from '../../engine/domain/capture.js';
import {normalizeUsage, withEstimates, headroom} from '../../engine/domain/usage.js';
import {
    isDue, blockAfter429, activeInterval, recordAttempt, ACTIVE_MIN_S, INACTIVE_S, FORCE_MIN_S,
    HARD_CAP_PER_HOUR,
} from '../../engine/domain/pollPolicy.js';
import {pickBest} from '../../engine/domain/pick.js';
import {redact} from '../../shared/redact.js';

const cred = (at, rt, exp = 1e13, extra = {}) =>
    ({claudeAiOauth: {accessToken: at, refreshToken: rt, expiresAt: exp, scopes: ['user:inference']}, ...extra});

suite('credential');

test('fp follows the refresh token, not the access token', () => {
    assert.equal(refreshFp(cred('a1', 'r1')), refreshFp(cred('a2', 'r1')));
    assert.ok(refreshFp(cred('a1', 'r1')) !== refreshFp(cred('a1', 'r2')));
    assert.equal(refreshFp(cred('a', '')), null);
});

test('wiped = both tokens empty, wrapper kept', () => {
    assert.ok(isWiped({claudeAiOauth: {accessToken: '', refreshToken: '', expiresAt: 0}}));
    assert.ok(!isWiped(cred('a', 'r')));
    assert.ok(!hasTokens({claudeAiOauth: {accessToken: 'a', refreshToken: ''}}));
});

test('compose: shared keys come from live (absence included), unknown keys stay with the slot', () => {
    const target = cred('ta', 'tr', 1, {mcpOAuth: {old: 1}, trustedDeviceToken: 'dev-b', futureKey: 7});
    const live = cred('la', 'lr', 1, {mcpOAuth: {live: 1}, pluginSecrets: {p: 1}});
    const out = composeForActivation(target, live);
    assert.deepEqual(out.mcpOAuth, {live: 1});
    assert.deepEqual(out.pluginSecrets, {p: 1});
    assert.equal(out.trustedDeviceToken, 'dev-b');
    assert.equal(out.futureKey, 7);
    assert.equal(out.claudeAiOauth.accessToken, 'ta');
    const noShared = composeForActivation(target, cred('x', 'y'));
    assert.ok(!('mcpOAuth' in noShared), 'absent in live -> absent');
    assert.equal(SHARED_KEYS.length, 5);
    assert.ok(!('mcpOAuth' in stripShared(target)));
});

test('direct refresh never touches scopes', () => {
    const c = cred('a', 'r', 0);
    c.claudeAiOauth.scopes = ['user:inference', 'user:profile'];
    const out = applyTokenResponse(c, {access_token: 'a2', refresh_token: 'r2', expires_in: 100, scope: 'user:profile'}, 1000);
    assert.deepEqual(out.claudeAiOauth.scopes, ['user:inference', 'user:profile']);
    assert.equal(out.claudeAiOauth.expiresAt, 101000);
    assert.equal(out.claudeAiOauth.refreshToken, 'r2');
});

test('loginExpiresAt, shape and expiry helpers', () => {
    const c = cred('a', 'r', 5000);
    c.claudeAiOauth.refreshTokenExpiresAt = Date.UTC(2026, 10, 15);
    assert.equal(loginExpiresAt(c), '2026-11-15T00:00:00Z');
    assert.equal(loginExpiresAt(cred('a', 'r')), null);
    assert.equal(shapeError({x: 1}), 'missing claudeAiOauth');
    assert.equal(shapeError({claudeAiOauth: {accessToken: 3}}), 'accessToken is not a string');
    assert.ok(isExpired(c, 4000, 2000));
    assert.ok(!isExpired(c, 1000, 2000));
});

suite('capture');

const reg = {accounts: [{uuid: 'A', number: 1}, {uuid: 'B', number: 2}]};
const acc = uuid => ({accountUuid: uuid, emailAddress: `${uuid}@x`, organizationUuid: 'o'});

test('none / wiped / unmanaged', () => {
    const slots = new Map();
    assert.equal(classifyLocal({live: null, liveAccount: null, registry: reg, slotCreds: slots}).kind, 'none');
    assert.equal(classifyLocal({live: {claudeAiOauth: {accessToken: '', refreshToken: ''}}, liveAccount: acc('A'), registry: reg, slotCreds: slots}).kind, 'wiped');
    assert.equal(classifyLocal({live: cred('a', 'r'), liveAccount: acc('Z'), registry: reg, slotCreds: slots}).kind, 'unmanaged');
});

test('same / newer / older-is-same', () => {
    const slots = new Map([['A', cred('a1', 'r1', 100)]]);
    const k = live => classifyLocal({live, liveAccount: acc('A'), registry: reg, slotCreds: slots}).kind;
    assert.equal(k(cred('a1', 'r1', 100, {mcpOAuth: {x: 1}})), 'same', 'shared keys ignored');
    assert.equal(k(cred('a2', 'r1', 200)), 'newer');
    assert.equal(k(cred('a0', 'r1', 50)), 'same');
});

test('rotated vs foreign (lineage held by another slot)', () => {
    const slots = new Map([['A', cred('a1', 'r1')], ['B', cred('b1', 'rB')]]);
    assert.equal(classifyLocal({live: cred('x', 'r2'), liveAccount: acc('A'), registry: reg, slotCreds: slots}).kind, 'rotated');
    const f = classifyLocal({live: cred('x', 'rB'), liveAccount: acc('A'), registry: reg, slotCreds: slots});
    assert.equal(f.kind, 'foreign');
    assert.equal(f.foreign.uuid, 'B');
});

test('resolveRotated with the profile answer', () => {
    const local = {kind: 'rotated', account: reg.accounts[0]};
    assert.equal(resolveRotated(local, {uuid: 'A'}, reg).kind, 'rotated-own');
    assert.equal(resolveRotated(local, {uuid: 'B'}, reg).kind, 'foreign');
    assert.equal(resolveRotated(local, {uuid: 'Q'}, reg).kind, 'alien');
    assert.equal(resolveRotated(local, null, reg).kind, 'rotated-unverified');
});

test('actions never write a foreign credential into a slot', () => {
    for (const k of ['foreign', 'alien'])
        assert.ok(!captureAction(k).copyToSlot && captureAction(k).stashLive);
    assert.ok(captureAction('rotated-unverified').stashPrevious);
    assert.ok(captureAction('wiped').markNeedsLogin && !captureAction('wiped').copyToSlot);
});

suite('usage');

test('normalises windows, new spend format and scoped limits; ignores unknown keys', () => {
    const u = normalizeUsage({
        five_hour: {utilization: 25.5, resets_at: '2026-11-01T23:00:00Z', locked_reason: null},
        seven_day: {utilization: 6, resets_at: '2026-11-06T18:00:00Z'},
        spend: {used: {amount_minor: 1230, currency: 'USD', exponent: 2}, limit: {amount_minor: 5000, exponent: 2}, percent: 24, severity: 'normal', enabled: true},
        limits: [{kind: 'weekly', percent: 72, resets_at: 'x', scope: {model: {display_name: 'Fable'}}}, {kind: 'x', percent: 1, scope: null}],
        amber_cistern: {a: 1},
    });
    assert.equal(u.fiveHour.pct, 25.5);
    assert.deepEqual(u.spend, {used: 12.3, limit: 50, pct: 24, currency: 'USD', severity: 'normal'});
    assert.deepEqual(u.scoped, [{name: 'Fable', pct: 72, resetsAt: 'x'}]);
});

test('legacy extra_usage with nulls -> no spend; disabled spend -> null', () => {
    assert.equal(normalizeUsage({extra_usage: {is_enabled: true, used_credits: null, monthly_limit: 10, utilization: 1}}).spend, null);
    assert.deepEqual(normalizeUsage({extra_usage: {is_enabled: true, used_credits: 250, monthly_limit: 1000, utilization: 25, currency: 'EUR'}}).spend,
        {used: 2.5, limit: 10, pct: 25, currency: 'EUR', severity: null});
    assert.equal(normalizeUsage({spend: {enabled: false, used: {amount_minor: 1}}}).spend, null);
    assert.equal(normalizeUsage('nope'), null);
    assert.equal(normalizeUsage({five_hour: {utilization: 'x'}}).fiveHour, null);
});

test('estimate: a passed reset shows 0 % estimated', () => {
    const u = normalizeUsage({five_hour: {utilization: 80, resets_at: '2020-01-01T00:00:00Z'}, seven_day: {utilization: 40, resets_at: '2999-01-01T00:00:00Z'}});
    const e = withEstimates(u, Date.now());
    assert.equal(e.fiveHour.pct, 0);
    assert.ok(e.fiveHour.estimated);
    assert.equal(e.sevenDay.pct, 40);
    assert.ok(!e.sevenDay.estimated);
    assert.equal(headroom(e), 60);
});

suite('pollPolicy');

test('intervals: active 180 s (min 120), inactive 30 min, network 5 min', () => {
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    const e = {lastAttemptAt: new Date(t0).toISOString()};
    assert.ok(!isDue(e, t0 + 179e3, {isActive: true}));
    assert.ok(isDue(e, t0 + 180e3, {isActive: true}));
    assert.equal(activeInterval(30), ACTIVE_MIN_S);
    assert.ok(!isDue(e, t0 + (INACTIVE_S - 1) * 1e3, {isActive: false}));
    assert.ok(isDue(e, t0 + INACTIVE_S * 1e3, {isActive: false}));
    assert.ok(isDue({...e, lastError: 'network'}, t0 + 300e3, {isActive: false}));
    assert.ok(!isDue(e, t0 + (FORCE_MIN_S - 1) * 1e3, {isActive: true, force: true}));
});

test('429: Retry-After + 15 min, or one hour; force cannot bypass a block', () => {
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    assert.equal(blockAfter429(t0, 120), new Date(t0 + (120 + 900) * 1e3).toISOString());
    assert.equal(blockAfter429(t0, null), new Date(t0 + 3600e3).toISOString());
    const e = {lastAttemptAt: new Date(t0).toISOString(), blockedUntil: blockAfter429(t0, null)};
    assert.ok(!isDue(e, t0 + 3599e3, {isActive: true, force: true}));
    assert.ok(isDue(e, t0 + 3600e3, {isActive: true}));
});

test('budget: <= 20/h per account normally and <= 25/h even mashing --force, over 24 h', () => {
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    const simulate = (isActive, forceEvery) => {
        let entry;
        const fetches = [];
        for (let s = 0; s < 24 * 3600; s += 7) { // panel opened / timer every 7 s
            const now = t0 + s * 1e3;
            const force = forceEvery > 0 && s % forceEvery === 0;
            if (isDue(entry, now, {isActive, force})) {
                fetches.push(s);
                entry = recordAttempt(entry, now);
            }
        }
        // worst trailing 60-minute window
        let worst = 0;
        for (let i = 0; i < fetches.length; i++) {
            let j = i;
            while (j < fetches.length && fetches[j] - fetches[i] < 3600)
                j++;
            worst = Math.max(worst, j - i);
        }
        return worst;
    };
    for (const isActive of [true, false]) {
        assert.ok(simulate(isActive, 0) <= 20, `${isActive}: ${simulate(isActive, 0)} > 20`);
        assert.ok(simulate(isActive, 63) <= HARD_CAP_PER_HOUR, `forced: ${simulate(isActive, 63)}`);
    }
});

suite('pick');

test('--best skips disabled, needs-login and the active account; unknown usage ranks last', () => {
    const accounts = [
        {uuid: 'A', number: 1}, {uuid: 'B', number: 2}, {uuid: 'C', number: 3, disabled: true},
        {uuid: 'D', number: 4, state: 'needs-login'}, {uuid: 'E', number: 5},
    ];
    const u = new Map([
        ['A', {fiveHour: {pct: 1}}], ['B', {fiveHour: {pct: 50}, sevenDay: {pct: 10}}],
        ['C', {fiveHour: {pct: 0}}], ['D', {fiveHour: {pct: 0}}], ['E', null],
    ]);
    assert.equal(pickBest(accounts, u, 'A').uuid, 'B');
    assert.equal(pickBest(accounts.slice(4), u, null).uuid, 'E');
    assert.equal(pickBest([accounts[0]], u, 'A'), null);
});

suite('redact');

test('removes tokens and bearer values, keeps the rest', () => {
    const s = redact('x sk-ant-oat01-ABC_def-123 y Bearer abcdefghijklmnopqrst z');
    assert.equal(s, 'x sk-ant-*** y Bearer *** z');
    assert.equal(redact('a'.repeat(10), 5).length, 5);
});
