// Imitates `claude` as observed on 2.1.316 for tests and the sandbox:
//   --version | auth status [--json] | auth login
// Uses CLAUDE_ACCOUNTS_API_BASE / CLAUDE_ACCOUNTS_TOKEN_URL of the fake API. Never talks to the
// real Anthropic endpoints.
//
// Env knobs: FAKE_LOGIN_ACCOUNT (uuid to log in as), FAKE_LOGIN_DELAY_MS,
// FAKE_LOGIN_FAIL=1, FAKE_LOGIN_HANG=1, FAKE_ORPHAN_LOCK=1.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

const env = n => GLib.getenv(n);
const home = env('HOME');
const cfgDir = env('CLAUDE_CONFIG_DIR') || `${home}/.claude`;
const globalCfg = env('CLAUDE_CONFIG_DIR') ? `${cfgDir}/.claude.json` : `${home}/.claude.json`;
const credPath = `${cfgDir}/.credentials.json`;
const dec = new TextDecoder();

function read(path) {
    try {
        return JSON.parse(dec.decode(GLib.file_get_contents(path)[1]));
    } catch {
        return null;
    }
}

function write(path, obj) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents_full(path, new TextEncoder().encode(`${JSON.stringify(obj, null, 2)}\n`),
        GLib.FileSetContentsFlags.CONSISTENT, 0o600);
}

function post(url, body) {
    const s = new Soup.Session({timeout: 10});
    const m = Soup.Message.new('POST', url);
    m.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
    const b = s.send_and_read(m, null);
    return {status: m.status_code, json: JSON.parse(dec.decode(b.get_data()) || 'null')};
}

function lock(path) {
    for (let i = 0; i < 200; i++) {
        try {
            Gio.File.new_for_path(path).make_directory(null);
            return () => Gio.File.new_for_path(path).delete(null);
        } catch {
            GLib.usleep(50000);
        }
    }
    throw new Error('lock busy');
}

function migrations() {
    if (!env('CLAUDE_CONFIG_DIR'))
        return;
    const c = read(globalCfg) ?? {};
    if (c.firstStartTime)
        return;
    Object.assign(c, {firstStartTime: new Date().toISOString(), machineID: 'fake', migrationVersion: 7});
    write(globalCfg, c);
    if (env('FAKE_ORPHAN_LOCK') === '1')
        GLib.mkdir_with_parents(`${globalCfg}.lock`, 0o755); // as seen on 2.1.316
}

function status() {
    migrations();
    const cred = read(credPath);
    const o = cred?.claudeAiOauth;
    if (o?.refreshToken && typeof o.expiresAt === 'number' && o.expiresAt <= Date.now()) {
        const release = lock(`${cfgDir}/.oauth_refresh.lock`);
        try {
            const r = post(env('CLAUDE_ACCOUNTS_TOKEN_URL'), {grant_type: 'refresh_token', refresh_token: o.refreshToken});
            if (r.status === 200) {
                o.accessToken = r.json.access_token;
                o.refreshToken = r.json.refresh_token ?? o.refreshToken;
                o.expiresAt = Date.now() + r.json.expires_in * 1000;
            } else if (r.json?.error === 'invalid_grant') {
                Object.assign(o, {accessToken: '', refreshToken: '', expiresAt: 0});
            }
            write(credPath, cred);
        } finally {
            release();
        }
    }
    const acct = read(globalCfg)?.oauthAccount;
    // Like the real CLI, loggedIn stays true even with wiped tokens.
    print(JSON.stringify({
        loggedIn: Boolean(o), authMethod: 'claude.ai', apiProvider: 'firstParty',
        email: acct?.emailAddress, orgId: acct?.organizationUuid, orgName: acct?.organizationName,
        subscriptionType: o?.subscriptionType ?? 'pro', configDirectory: cfgDir,
    }, null, 2));
}

function login() {
    const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake&redirect_uri=http%3A%2F%2Flocalhost%3A45555%2Fcallback&state=fake';
    print('Opening browser to sign in…');
    print(`If the browser didn't open, visit: ${url}`);
    const browser = env('BROWSER');
    if (browser)
        Gio.Subprocess.new([browser, url], Gio.SubprocessFlags.NONE);
    if (env('FAKE_LOGIN_HANG') === '1')
        GLib.usleep(600 * 1e6);
    GLib.usleep(Number(env('FAKE_LOGIN_DELAY_MS') ?? 500) * 1000);
    if (env('FAKE_LOGIN_FAIL') === '1')
        System.exit(1);
    const uuid = env('FAKE_LOGIN_ACCOUNT');
    const r = post(`${env('CLAUDE_ACCOUNTS_API_BASE')}/__admin/issue`, {uuid});
    if (r.status !== 200)
        System.exit(1);
    const t = r.json;
    write(credPath, {
        claudeAiOauth: {
            accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt,
            refreshTokenExpiresAt: t.refreshTokenExpiresAt, scopes: ['user:inference', 'user:profile'],
            subscriptionType: 'max', rateLimitTier: 'default', subscriptionTypeSource: 'fake',
        },
    });
    const c = read(globalCfg) ?? {};
    c.oauthAccount = {
        accountUuid: t.account.uuid, emailAddress: t.account.email,
        organizationUuid: t.account.orgUuid, organizationName: t.account.orgName, displayName: 'Fake',
    };
    write(globalCfg, c);
    print('Login successful.');
}

const [a, b] = ARGV;
if (a === '--version')
    print('2.1.316 (Claude Code) [fake]');
else if (a === 'auth' && b === 'status')
    status();
else if (a === 'auth' && b === 'login')
    login();
else
    System.exit(2);
