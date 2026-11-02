// End-to-end tests of the engine CLI in a sandbox.

import GLib from 'gi://GLib';
import {suite, test, assert} from '../lib/harness.js';
import {sharedApi, Sandbox, ACCOUNTS, readJson, writeFile, readFile} from '../lib/sandbox.js';

const {A, B, C} = ACCOUNTS;
const getApi = sharedApi;

/** Sandbox with A live and saved, B saved through the login flow. */
function twoAccounts() {
    const sb = new Sandbox(getApi());
    getApi().scenario({});
    sb.login(A);
    const r1 = sb.run(['add', '--current']);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    const r2 = sb.addViaLogin(B);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    return sb;
}

suite('cli');

test('json envelope, version and unknown command', () => {
    const sb = new Sandbox(getApi());
    const v = sb.run(['--version']);
    assert.equal(v.json.version, '0.2.0');
    const bad = sb.run(['frobnicate']);
    assert.equal(bad.status, 1);
    assert.equal(bad.json.schemaVersion, 1);
    assert.equal(bad.json.error.kind, 'invalid');
    assert.ok(bad.json.testing, 'testing flag present in sandbox');
});

test('status/list with no session and no accounts', () => {
    const sb = new Sandbox(getApi());
    const s = sb.run(['status']);
    assert.equal(s.json.active.capture, 'none');
    const l = sb.run(['list', '--cached']);
    assert.deepEqual(l.json.accounts, []);
});

suite('add');

test('add --current saves the live login without machine-shared keys', () => {
    const sb = new Sandbox(getApi());
    sb.login(A);
    const r = sb.run(['add', '--current']);
    assert.equal(r.status, 0, r.stdout);
    assert.ok(r.json.added);
    assert.equal(r.json.account.number, 1);
    const slot = sb.slotCred(A.uuid);
    assert.equal(slot.claudeAiOauth.refreshToken, sb.liveCred().claudeAiOauth.refreshToken);
    assert.ok(!('mcpOAuth' in slot), 'mcpOAuth is machine state, not stored per account');
    const again = sb.run(['add', '--current']);
    assert.ok(!again.json.added && again.json.updated);
    const perms = GLib.spawn_command_line_sync(`stat -c %a ${sb.path('.local/share/claude-accounts')} ${sb.path(`.local/share/claude-accounts/accounts/${A.uuid}/.credentials.json`)}`)[1];
    assert.equal(new TextDecoder().decode(perms).trim().split('\n').join(','), '700,600');
});

test('add --current with a wiped or missing session fails with exit 3', () => {
    const sb = new Sandbox(getApi());
    assert.equal(sb.run(['add', '--current']).json.error.kind, 'no-session');
    sb.login(A);
    const c = sb.liveCred();
    Object.assign(c.claudeAiOauth, {accessToken: '', refreshToken: '', expiresAt: 0});
    writeFile(sb.path('.claude/.credentials.json'), JSON.stringify(c));
    const r = sb.run(['add', '--current']);
    assert.equal(r.status, 3);
    assert.equal(r.json.error.kind, 'wiped');
});

test('add --login: isolated login, live session untouched byte for byte', () => {
    const sb = new Sandbox(getApi());
    sb.login(A);
    const before = readFile(sb.path('.claude/.credentials.json'));
    const cfgBefore = readFile(sb.path('.claude.json'));
    const r = sb.addViaLogin(B);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const events = r.lines.map(l => JSON.parse(l));
    assert.ok(events.some(e => e.event === 'waiting'));
    assert.ok(events.some(e => e.event === 'auth-url' && e.url.includes('redirect_uri=http')));
    assert.equal(events.at(-1).event, 'done');
    assert.ok(events.at(-1).added);
    assert.equal(readFile(sb.path('.claude/.credentials.json')), before);
    assert.equal(readFile(sb.path('.claude.json')), cfgBefore);
    assert.ok(sb.slotCred(B.uuid).claudeAiOauth.accessToken);
    assert.deepEqual(GLib.file_test(sb.path('.local/share/claude-accounts/tmp'), GLib.FileTest.IS_DIR) &&
        new TextDecoder().decode(GLib.spawn_command_line_sync(`ls -A ${sb.path('.local/share/claude-accounts/tmp')}`)[1]).trim(), '');
});

test('add --login failure and cancel leave no temp dir and no account', () => {
    const sb = new Sandbox(getApi());
    const fail = sb.addViaLogin(C, {FAKE_LOGIN_FAIL: '1'});
    assert.equal(fail.json.event, 'error');
    assert.equal(fail.json.error.kind, 'login-failed');
    // cancel: start a hanging login, then SIGTERM it through `add --cancel`
    const p = sb.spawn(['gjs', '-m', `${GLib.get_current_dir()}/engine/main.js`, 'add', '--login', '--json',
        '--claude-path', `${GLib.get_current_dir()}/tests/fakeClaude`], {FAKE_LOGIN_HANG: '1', FAKE_LOGIN_ACCOUNT: C.uuid});
    GLib.usleep(1500000);
    const c = sb.run(['add', '--cancel']);
    assert.equal(c.json.cancelled, 1);
    const [, out] = p.communicate_utf8(null, null);
    const last = JSON.parse(out.trim().split('\n').at(-1));
    assert.equal(last.error.kind, 'cancelled');
    assert.equal(new TextDecoder().decode(GLib.spawn_command_line_sync(`ls -A ${sb.path('.local/share/claude-accounts/tmp')}`)[1]).trim(), '');
    assert.equal(sb.registry()?.accounts?.length ?? 0, 0);
});

test('add --login of an existing account renews it (needs-login -> ok) and stashes the old copy', () => {
    const sb = twoAccounts();
    const reg = sb.registry();
    reg.accounts.find(a => a.uuid === B.uuid).state = 'needs-login';
    writeFile(sb.path('.local/share/claude-accounts/registry.json'), JSON.stringify(reg));
    const old = sb.slotCred(B.uuid).claudeAiOauth.refreshToken;
    const r = sb.addViaLogin(B);
    assert.ok(r.json.renewed, r.stdout);
    assert.equal(sb.registry().accounts.find(a => a.uuid === B.uuid).state, 'ok');
    assert.ok(sb.slotCred(B.uuid).claudeAiOauth.refreshToken !== old);
    assert.ok(sb.stash().some(n => n.includes('-relogin-')));
});

suite('switch');

test('switch keeps conversations: only the credential and oauthAccount change', () => {
    const sb = twoAccounts();
    const treeBefore = sb.claudeTreeHashes();
    const cfgBefore = sb.configWithoutAccount();
    const liveA = sb.liveCred();
    const r = sb.run(['switch', '2']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.json.switched);
    assert.equal(r.json.to.email, B.email);
    assert.equal(r.json.from.email, A.email);
    assert.equal(r.json.verified, true);
    assert.equal(sb.liveAccount().accountUuid, B.uuid);
    assert.equal(sb.liveCred().claudeAiOauth.refreshToken, sb.slotCred(B.uuid).claudeAiOauth.refreshToken);
    assert.deepEqual(sb.liveCred().mcpOAuth, liveA.mcpOAuth, 'machine-shared keys stay');
    assert.deepEqual(sb.claudeTreeHashes(), treeBefore, 'projects/, history.jsonl… byte-identical');
    assert.deepEqual(sb.configWithoutAccount(), cfgBefore, 'every other ~/.claude.json key preserved');
    // and back
    for (let i = 0; i < 5; i++) {
        assert.ok(sb.run(['switch', '1']).json.switched);
        assert.ok(sb.run(['switch', B.email]).json.switched);
    }
    assert.deepEqual(sb.claudeTreeHashes(), treeBefore);
    assert.deepEqual(sb.configWithoutAccount(), cfgBefore);
});

test('switch to the active account: switched false, exit 2', () => {
    const sb = twoAccounts();
    const r = sb.run(['switch', '1']);
    assert.equal(r.status, 2);
    assert.equal(r.json.reason, 'already-active');
});

test('switch to an unknown or needs-login account changes nothing', () => {
    const sb = twoAccounts();
    const before = readFile(sb.path('.claude/.credentials.json'));
    assert.equal(sb.run(['switch', '9']).json.error.kind, 'not-found');
    const reg = sb.registry();
    reg.accounts[1].state = 'needs-login';
    writeFile(sb.path('.local/share/claude-accounts/registry.json'), JSON.stringify(reg));
    const r = sb.run(['switch', '2']);
    assert.equal(r.status, 3);
    assert.equal(r.json.error.kind, 'needs-login');
    assert.equal(readFile(sb.path('.claude/.credentials.json')), before);
});

test('every injected failure rolls back to the exact previous state', () => {
    for (const point of ['after-capture', 'before-credentials', 'after-credentials', 'after-config']) {
        const sb = twoAccounts();
        const cred = readFile(sb.path('.claude/.credentials.json'));
        const cfg = readFile(sb.path('.claude.json'));
        const r = sb.run(['switch', '2'], {CLAUDE_ACCOUNTS_FAULT: point});
        assert.equal(r.status, 1, point);
        if (point !== 'after-capture')
            assert.ok(r.json.error.rolledBack, `${point}: ${r.stdout}`);
        assert.equal(readFile(sb.path('.claude/.credentials.json')), cred, point);
        assert.equal(readFile(sb.path('.claude.json')), cfg, point);
        assert.ok(!GLib.file_test(sb.path('.claude/.oauth_refresh.lock'), GLib.FileTest.EXISTS), 'locks released');
        assert.ok(!GLib.file_test(sb.path('.claude.json.lock'), GLib.FileTest.EXISTS), 'config lock released');
        sb.cleanup();
    }
});

test('the outgoing account keeps the token Claude Code rotated (no /login needed to return)', () => {
    const sb = twoAccounts();
    // Claude Code rotates A's token while A is active.
    const rot = sb.spawn(['gjs', '-m', `${GLib.get_current_dir()}/tests/fakeClaudeCode.js`, '--rotations', '3']);
    rot.wait(null);
    const rotated = sb.liveCred().claudeAiOauth.refreshToken;
    assert.ok(rotated !== sb.slotCred(A.uuid).claudeAiOauth.refreshToken);
    assert.ok(sb.run(['switch', '2']).json.switched);
    assert.equal(sb.slotCred(A.uuid).claudeAiOauth.refreshToken, rotated);
    assert.ok(sb.stash().some(n => n.includes('-superseded-')), 'previous generation kept');
    const valid = getApi().state().validRefresh[A.uuid];
    assert.ok(valid.includes(rotated), 'stored token is the one the server still accepts');
});

test('unmanaged live login is stashed before being replaced', () => {
    const sb = twoAccounts();
    sb.login(C); // the user /login'ed with an account the switcher does not know
    const l = sb.run(['list', '--cached']);
    assert.equal(l.json.active.capture, 'unmanaged');
    assert.equal(l.json.active.managed, false);
    assert.ok(sb.run(['switch', '1']).json.switched);
    assert.ok(sb.stash().some(n => n.includes('-displaced-live-login-')));
});

test('a stale orphaned ~/.claude.json.lock is taken over (wait > 10 s, < 15 s)', () => {
    const sb = twoAccounts();
    GLib.mkdir_with_parents(sb.path('.claude.json.lock'), 0o755);
    const t0 = Date.now();
    const r = sb.run(['switch', '2']);
    const dt = Date.now() - t0;
    assert.ok(r.json.switched, r.stdout);
    assert.ok(dt > 9000 && dt < 16000, `took ${dt} ms`);
}, {slow: true});

test('a held live credential lock makes switch fail cleanly after ~9 s', () => {
    const sb = twoAccounts();
    const lock = sb.path('.claude/.oauth_refresh.lock');
    GLib.mkdir_with_parents(lock, 0o755);
    const keep = GLib.timeout_add(0, 2000, () => GLib.SOURCE_CONTINUE); // placeholder, lock is fresh (< 60 s)
    GLib.source_remove(keep);
    const before = readFile(sb.path('.claude/.credentials.json'));
    const t0 = Date.now();
    const r = sb.run(['switch', '2']);
    const dt = Date.now() - t0;
    assert.equal(r.json.error.kind, 'lock-timeout', r.stdout);
    assert.ok(dt > 8500 && dt < 14000, `took ${dt} ms`);
    assert.equal(readFile(sb.path('.claude/.credentials.json')), before);
    assert.ok(GLib.file_test(lock, GLib.FileTest.IS_DIR), "Claude Code's lock is not stolen");
}, {slow: true});

test('switch --best picks the account with most headroom', () => {
    const sb = twoAccounts();
    sb.api.account(B, {five_hour: {utilization: 5, resets_at: '2999-01-01T00:00:00Z'}, seven_day: {utilization: 10, resets_at: '2999-01-01T00:00:00Z'}});
    const c = sb.addViaLogin(C);
    assert.equal(c.status, 0);
    sb.api.account(C, {five_hour: {utilization: 70, resets_at: '2999-01-01T00:00:00Z'}, seven_day: {utilization: 10, resets_at: '2999-01-01T00:00:00Z'}});
    sb.run(['list', '--force']);
    const r = sb.run(['switch', '--best']);
    assert.equal(r.json.to.email, B.email, r.stdout);
});

suite('capture');

test('rotated lineage, profile confirms -> copied; profile down -> copied + unverified + stash', () => {
    const sb = twoAccounts();
    const t = sb.api.issue(A.uuid); // a new login of A (different lineage)
    const c = sb.liveCred();
    Object.assign(c.claudeAiOauth, {accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt});
    writeFile(sb.path('.claude/.credentials.json'), JSON.stringify(c));
    const l = sb.run(['list', '--cached']);
    assert.equal(l.json.active.capture, 'rotated-unverified', 'no network with --cached: not resolved');
    sb.api.scenario({profile: 'down'});
    const l2 = sb.run(['list']);
    assert.equal(l2.json.active.capture, 'rotated-unverified');
    assert.equal(sb.registry().accounts[0].state, 'unverified');
    assert.equal(sb.slotCred(A.uuid).claudeAiOauth.refreshToken, t.refreshToken);
    assert.ok(sb.stash().some(n => n.includes('-superseded-')));
    sb.api.scenario({});
    const t2 = sb.api.issue(A.uuid);
    Object.assign(c.claudeAiOauth, {accessToken: t2.accessToken, refreshToken: t2.refreshToken, expiresAt: t2.expiresAt});
    writeFile(sb.path('.claude/.credentials.json'), JSON.stringify(c));
    assert.equal(sb.run(['list']).json.active.capture, 'rotated-own');
    assert.equal(sb.registry().accounts[0].state, 'ok');
});

test('foreign credential (profile says another account) is stashed, never written to a slot', () => {
    const sb = twoAccounts();
    const t = sb.api.issue(A.uuid);
    const c = sb.liveCred();
    Object.assign(c.claudeAiOauth, {accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt});
    writeFile(sb.path('.claude/.credentials.json'), JSON.stringify(c));
    const slotBefore = readFile(sb.path(`.local/share/claude-accounts/accounts/${A.uuid}/.credentials.json`));
    sb.api.scenario({profile: 'other'});
    const l = sb.run(['list']);
    assert.equal(l.json.active.capture, 'alien');
    assert.ok(l.json.warnings.length > 0);
    assert.equal(readFile(sb.path(`.local/share/claude-accounts/accounts/${A.uuid}/.credentials.json`)), slotBefore);
    assert.ok(sb.stash().some(n => n.includes('-alien-')));
    sb.run(['list']);
    assert.equal(sb.stash().filter(n => n.includes('-alien-')).length, 1, 'stash is deduplicated');
    const sw = sb.run(['switch', '2']);
    assert.ok(sw.json.switched, sw.stdout);
    assert.ok(sw.json.warnings.some(w => w.includes('does not know')), 'the switch reports the foreign credential');
    sb.api.scenario({});
});

test('wiped live session marks the account needs-login without overwriting its copy', () => {
    const sb = twoAccounts();
    const slotBefore = readFile(sb.path(`.local/share/claude-accounts/accounts/${A.uuid}/.credentials.json`));
    const c = sb.liveCred();
    Object.assign(c.claudeAiOauth, {accessToken: '', refreshToken: '', expiresAt: 0});
    writeFile(sb.path('.claude/.credentials.json'), JSON.stringify(c));
    const l = sb.run(['list', '--cached']);
    assert.equal(l.json.active.capture, 'wiped');
    assert.equal(l.json.accounts[0].state, 'needs-login');
    assert.equal(readFile(sb.path(`.local/share/claude-accounts/accounts/${A.uuid}/.credentials.json`)), slotBefore);
});

suite('usage');

test('list fetches usage, normalises it and respects the cadence', () => {
    const sb = twoAccounts();
    sb.api.account(A, {five_hour: {utilization: 42, resets_at: '2999-01-01T00:00:00Z'}, seven_day: {utilization: 7, resets_at: '2999-01-02T00:00:00Z'}});
    const before = sb.api.state().stats.usage[A.uuid] ?? 0;
    const l = sb.run(['list']);
    const a = l.json.accounts.find(x => x.uuid === A.uuid);
    assert.equal(a.active, true);
    assert.equal(a.usage.fiveHour.pct, 42);
    assert.equal(a.usage.fiveHour.estimated, false);
    assert.ok(a.nextPollAt);
    assert.ok(a.isPersonalOrg);
    assert.ok(!l.json.accounts.find(x => x.uuid === B.uuid).isPersonalOrg);
    sb.run(['list']);
    sb.run(['list']);
    assert.equal(sb.api.state().stats.usage[A.uuid], before + 1, 'second and third list do not hit the API');
});

test('429 blocks the account until Retry-After + margin, even with --force', () => {
    const sb = twoAccounts();
    sb.api.scenario({usage: '429'});
    const l = sb.run(['list', '--force']);
    assert.equal(l.json.accounts[0].usageError, 'http-429');
    const n = sb.api.state().stats.usage[A.uuid];
    sb.api.scenario({});
    sb.run(['list', '--force']);
    assert.equal(sb.api.state().stats.usage[A.uuid], n, 'no request while blocked');
    const cache = readJson(sb.path('.cache/claude-accounts/usage.json'));
    const blocked = Date.parse(cache.accounts[A.uuid].blockedUntil) - Date.now();
    assert.ok(blocked > 1000e3 && blocked < 1030e3, `blocked ${blocked}`);
});

test('network/garbage/500 errors keep last good data and are reported', () => {
    const sb = twoAccounts();
    sb.run(['list']);
    const cache = readJson(sb.path('.cache/claude-accounts/usage.json'));
    for (const e of Object.values(cache.accounts))
        e.lastAttemptAt = '2000-01-01T00:00:00Z';
    writeFile(sb.path('.cache/claude-accounts/usage.json'), JSON.stringify(cache));
    sb.api.scenario({usage: 'garbage'});
    const l = sb.run(['list']);
    const a = l.json.accounts[0];
    assert.equal(a.usageError, 'bad-response');
    assert.ok(a.usage && a.usage.fiveHour, 'last good usage kept');
    sb.api.scenario({});
});

test('inactive expired token is refreshed through the official CLI (delegate) and rotated', () => {
    const sb = twoAccounts();
    const slotPath = sb.path(`.local/share/claude-accounts/accounts/${B.uuid}/.credentials.json`);
    const s = readJson(slotPath);
    const oldRt = s.claudeAiOauth.refreshToken;
    s.claudeAiOauth.expiresAt = Date.now() - 1000;
    writeFile(slotPath, JSON.stringify(s));
    const l = sb.run(['list']);
    const b = l.json.accounts.find(x => x.uuid === B.uuid);
    assert.equal(b.usageError, null, l.stdout);
    const after = readJson(slotPath).claudeAiOauth;
    assert.ok(after.refreshToken !== oldRt && after.expiresAt > Date.now());
    assert.ok(!sb.stash().some(n => n.includes('-pre-refresh-')), 'pre-refresh copy removed on success');
});

test('dead refresh token -> needs-login, pre-refresh copy kept (claude wipes the slot)', () => {
    const sb = twoAccounts();
    const slotPath = sb.path(`.local/share/claude-accounts/accounts/${B.uuid}/.credentials.json`);
    const s = readJson(slotPath);
    s.claudeAiOauth.expiresAt = Date.now() - 1000;
    s.claudeAiOauth.refreshToken = 'sk-ant-ort01-FAKEdead';
    writeFile(slotPath, JSON.stringify(s));
    const l = sb.run(['list']);
    const b = l.json.accounts.find(x => x.uuid === B.uuid);
    assert.equal(b.state, 'needs-login', l.stdout);
    assert.ok(sb.stash().some(n => n.includes('-pre-refresh-')));
});

test('direct strategy refreshes with the token endpoint; invalid_client falls back to the CLI', () => {
    const sb = twoAccounts();
    const slotPath = sb.path(`.local/share/claude-accounts/accounts/${B.uuid}/.credentials.json`);
    const expire = () => {
        const s = readJson(slotPath);
        s.claudeAiOauth.expiresAt = Date.now() - 1000;
        writeFile(slotPath, JSON.stringify(s));
        return s.claudeAiOauth;
    };
    let old = expire();
    let l = sb.run(['list', '--refresh-strategy', 'direct']);
    assert.equal(l.json.accounts.find(x => x.uuid === B.uuid).usageError, null, l.stdout);
    const now = readJson(slotPath).claudeAiOauth;
    assert.ok(now.refreshToken !== old.refreshToken);
    assert.deepEqual(now.scopes, old.scopes, 'scopes untouched');
    // invalid_client: the token endpoint refuses our client -> delegate
    const cache = readJson(sb.path('.cache/claude-accounts/usage.json'));
    cache.accounts[B.uuid].lastAttemptAt = '2000-01-01T00:00:00Z';
    writeFile(sb.path('.cache/claude-accounts/usage.json'), JSON.stringify(cache));
    old = expire();
    sb.api.scenario({token: 'invalid_client'});
    l = sb.run(['list', '--refresh-strategy', 'direct']);
    sb.api.scenario({});
    assert.ok(l.json.warnings.some(w => w.includes('OAuth client')), l.stdout);
});

test('the live token is never refreshed by the engine, even if expired', () => {
    const sb = twoAccounts();
    const c = sb.liveCred();
    c.claudeAiOauth.expiresAt = Date.now() - 1000;
    writeFile(sb.path('.claude/.credentials.json'), JSON.stringify(c));
    const tokenCalls = sb.api.state().stats.token;
    sb.run(['list', '--force']);
    assert.equal(sb.api.state().stats.token, tokenCalls);
    assert.equal(sb.liveCred().claudeAiOauth.refreshToken, c.claudeAiOauth.refreshToken);
});

suite('manage');

test('alias, disable/enable, remove (to stash) and doctor', () => {
    const sb = twoAccounts();
    assert.equal(sb.run(['alias', '2', 'trabajo']).json.alias, 'trabajo');
    assert.equal(sb.run(['alias', '1', '7']).json.error.kind, 'invalid');
    assert.ok(sb.run(['switch', 'trabajo']).json.switched);
    assert.ok(sb.run(['switch', '1']).json.switched);
    assert.ok(sb.run(['disable', '2']).json.disabled);
    assert.equal(sb.run(['switch', '--best']).json.reason, 'no-candidate');
    sb.run(['enable', '2']);
    assert.equal(sb.run(['remove', '1']).json.error.kind, 'active');
    const r = sb.run(['remove', '2']);
    assert.ok(r.json.stash.startsWith('removed-'));
    assert.ok(GLib.file_test(sb.path(`.local/share/claude-accounts/stash/${r.json.stash}/.credentials.json`), GLib.FileTest.EXISTS));
    assert.equal(sb.registry().accounts.length, 1);
    const d = sb.run(['doctor']);
    assert.ok(d.json.checks.find(c => c.id === 'claude').ok);
    assert.ok(d.json.checks.find(c => c.id === 'auth-status-fields').ok, d.stdout);
});

test('CLAUDE_CONFIG_DIR in the environment does not change the managed profile', () => {
    const sb = twoAccounts();
    const other = sb.path('other-profile');
    GLib.mkdir_with_parents(other, 0o700);
    const l = sb.run(['list', '--cached'], {CLAUDE_CONFIG_DIR: other});
    assert.equal(l.json.active.number, 1);
});
