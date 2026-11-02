// Development sandbox: a fake HOME with fake accounts and a fake API, so the
// extension can run in a nested/headless GNOME Shell WITHOUT touching the real
// ~/.claude.
//
//   gjs -m tools/sandbox.js setup <root> [--accounts 3|8|1]
//   gjs -m tools/sandbox.js stop <root>
//
// Writes <root>/env with the variables the nested shell must run with.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

const REPO = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
const [cmd, root] = ARGV;
const nAccounts = ARGV.includes('--accounts') ? Number(ARGV[ARGV.indexOf('--accounts') + 1]) : 3;
const enc = new TextEncoder();
const dec = new TextDecoder();

if (!root || !root.startsWith('/tmp/cas-sandbox')) {
    printerr('root must start with /tmp/cas-sandbox');
    System.exit(2);
}
const home = `${root}/home`;
const apiDir = `${root}/api`;

function sh(argv, env = null) {
    const l = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE});
    if (env)
        l.set_environ(Object.entries(env).map(([k, v]) => `${k}=${v}`));
    const p = l.spawnv(argv);
    const [, out, err] = p.communicate_utf8(null, null);
    return {ok: p.get_successful(), out, err};
}

function write(path, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents_full(path, enc.encode(text), GLib.FileSetContentsFlags.CONSISTENT, 0o600);
}

function stop() {
    const pid = Number(GLib.file_test(`${root}/api.pid`, GLib.FileTest.EXISTS)
        ? dec.decode(GLib.file_get_contents(`${root}/api.pid`)[1]) : 0);
    if (pid > 0)
        sh(['kill', String(pid)]);
}

if (cmd === 'stop') {
    stop();
    System.exit(0);
}
if (cmd !== 'setup') {
    printerr('usage: sandbox.js setup|stop <root>');
    System.exit(2);
}

stop();
sh(['rm', '-rf', root]);
GLib.mkdir_with_parents(home, 0o700);
GLib.mkdir_with_parents(apiDir, 0o700);

// fake API (survives this script)
const api = Gio.Subprocess.new(['setsid', 'gjs', '-m', `${REPO}/tests/fakeApi.js`, '--dir', apiDir], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
write(`${root}/api.pid`, api.get_identifier());
let port = 0;
for (let i = 0; i < 200 && !port; i++) {
    GLib.usleep(25000);
    try {
        port = Number(dec.decode(GLib.file_get_contents(`${apiDir}/port`)[1]));
    } catch {}
}
const base = `http://127.0.0.1:${port}`;
const session = new Soup.Session({timeout: 10});
function post(path, body) {
    const m = Soup.Message.new('POST', `${base}${path}`);
    m.set_request_body_from_bytes('application/json', new GLib.Bytes(enc.encode(JSON.stringify(body))));
    return JSON.parse(dec.decode(session.send_and_read(m, null).get_data()));
}

const env = {
    PATH: GLib.getenv('PATH'), HOME: home, LANG: 'C.UTF-8',
    CLAUDE_ACCOUNTS_TESTING: '1', CLAUDE_ACCOUNTS_NO_BROWSER: '1',
    CLAUDE_ACCOUNTS_API_BASE: base, CLAUDE_ACCOUNTS_TOKEN_URL: `${base}/v1/oauth/token`,
};
const iso = h => new Date(Date.now() + h * 3600e3).toISOString();
const PEOPLE = [
    ['alex@example.com', 'personal', 42, 18, 2.6, 96, null],
    ['work@company.com', 'work', 91, 63, 1.1, 30, 'Company Inc'],
    ['sam.rivera@example.com', null, 8, 3, 4.4, 140, null],
    ['projects@studio.dev', null, 76, 44, 0.5, 60, 'Studio Dev'],
    ['ana.lopez@example.org', null, 15, 71, 3.9, 20, null],
    ['bob.qa@company.com', null, 0, 12, 4.9, 150, 'Company Inc'],
    ['carla@example.com', null, 55, 35, 2, 75, null],
    ['dani@example.com', null, 33, 92, 1.5, 9, null],
];
const accounts = PEOPLE.slice(0, nAccounts).map(([email, alias, five, seven, h5, h7, org], i) => ({
    uuid: `acct-${String(i + 1).padStart(4, '0')}-sbx`,
    email, alias, orgUuid: `org-${i + 1}`,
    orgName: org ?? `${email}'s Organization`,
    usage: {
        five_hour: {utilization: five, resets_at: iso(h5)},
        seven_day: {utilization: seven, resets_at: iso(h7)},
        ...i === 2 ? {spend: {used: {amount_minor: 1230, currency: 'USD', exponent: 2}, limit: {amount_minor: 5000, exponent: 2}, percent: 24, severity: 'normal', enabled: true}} : {},
        ...i === 1 ? {limits: [{kind: 'weekly', percent: 84, resets_at: iso(70), scope: {model: {display_name: 'Fable'}}}]} : {},
    },
}));
for (const a of accounts)
    post('/__admin/account', a);

// live login = first account, with a realistic ~/.claude
const t = post('/__admin/issue', {uuid: accounts[0].uuid});
write(`${home}/.claude/.credentials.json`, JSON.stringify({
    claudeAiOauth: {
        accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt,
        refreshTokenExpiresAt: t.refreshTokenExpiresAt, scopes: ['user:inference'], subscriptionType: 'max',
    },
}, null, 2));
write(`${home}/.claude.json`, JSON.stringify({
    numStartups: 3, projects: {}, oauthAccount: {
        accountUuid: accounts[0].uuid, emailAddress: accounts[0].email,
        organizationUuid: accounts[0].orgUuid, organizationName: accounts[0].orgName,
    },
}, null, 2));
write(`${home}/.claude/projects/-home-demo/s1.jsonl`, '{"type":"user"}\n');

const engine = (...args) => sh(['gjs', '-m', `${REPO}/engine/main.js`, ...args, '--json', '--claude-path', `${REPO}/tests/fakeClaude`], env);
engine('add', '--current');
for (const a of accounts.slice(1))
    sh(['gjs', '-m', `${REPO}/engine/main.js`, 'add', '--login', '--json', '--claude-path', `${REPO}/tests/fakeClaude`], {...env, FAKE_LOGIN_ACCOUNT: a.uuid, FAKE_LOGIN_DELAY_MS: '20'});
accounts.forEach((a, i) => a.alias && engine('alias', String(i + 1), a.alias));
// account 3: its login expires in 2 days (shows the "Renew" hint)
if (nAccounts >= 3) {
    const p = `${home}/.local/share/claude-accounts/accounts/${accounts[2].uuid}/.credentials.json`;
    const c = JSON.parse(dec.decode(GLib.file_get_contents(p)[1]));
    c.claudeAiOauth.refreshTokenExpiresAt = Date.now() + 2 * 86400e3;
    write(p, JSON.stringify(c));
}
const l = engine('list', '--force');
const accountsOut = JSON.parse(l.out.trim().split('\n').at(-1)).accounts.length;

// the extension (symlinked) and the sandbox env
// the fake claude lives where a real one would, so no repository path shows up in the UI
GLib.mkdir_with_parents(`${home}/.local/bin`, 0o700);
sh(['ln', '-sfn', `${REPO}/tests/fakeClaude`, `${home}/.local/bin/claude`]);
GLib.mkdir_with_parents(`${home}/.local/share/gnome-shell/extensions`, 0o700);
sh(['ln', '-sfn', `${REPO}/extension`, `${home}/.local/share/gnome-shell/extensions/claude-account-switcher@oswaldocarabano.github.io`]);
sh(['ln', '-sfn', `${REPO}/tools/devtools`, `${home}/.local/share/gnome-shell/extensions/cas-devtools@sandbox.test`]);
write(`${root}/env`, `${Object.entries({...env, PATH: undefined, LANG: undefined})
    .filter(([, v]) => v !== undefined).map(([k, v]) => `export ${k}='${v}'`).join('\n')}\nexport CLAUDE_ACCOUNTS_REPO='${REPO}'\n`);
print(`sandbox ready: ${root} (${accountsOut} accounts, API ${base})`);
