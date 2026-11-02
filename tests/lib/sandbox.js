// Isolated test environment: temporary HOME under /tmp, fake API process,
// fake `claude`. Refuses to run anything against the real home directory.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

export const REPO = GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0])));
export const ENGINE = `${REPO}/engine/main.js`;
export const FAKE_CLAUDE = `${REPO}/tests/fakeClaude`;
const REAL_HOME = GLib.get_home_dir();
const dec = new TextDecoder();
const enc = new TextEncoder();

/** Everything any engine run printed, for the token-leak scan. */
export const transcript = [];
export const sandboxes = [];

export const ACCOUNTS = {
    A: {uuid: 'acct-aaaa-0001', email: 'ana@example.com', orgUuid: 'org-a', orgName: "ana@example.com's Organization"},
    B: {uuid: 'acct-bbbb-0002', email: 'beto@empresa.com', orgUuid: 'org-b', orgName: 'Empresa SA'},
    C: {uuid: 'acct-cccc-0003', email: 'carla@example.com', orgUuid: 'org-c', orgName: "carla@example.com's Organization"},
};

function assertSandboxPath(p) {
    if (!p.startsWith(`${GLib.get_tmp_dir()}/cas-test-`) || p.startsWith(REAL_HOME))
        throw new Error(`refusing to use a non-sandbox path: ${p}`);
}

export function readFile(p) {
    try {
        return dec.decode(GLib.file_get_contents(p)[1]);
    } catch {
        return null;
    }
}

export function writeFile(p, text, mode = 0o600) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(p), 0o700);
    GLib.file_set_contents_full(p, enc.encode(text), GLib.FileSetContentsFlags.CONSISTENT, mode);
}

export function readJson(p) {
    const t = readFile(p);
    return t === null ? null : JSON.parse(t);
}

export class FakeApi {
    constructor() {
        this.dir = GLib.dir_make_tmp('cas-test-api-XXXXXX');
        this.proc = Gio.Subprocess.new(['gjs', '-m', `${REPO}/tests/fakeApi.js`, '--dir', this.dir],
            Gio.SubprocessFlags.STDOUT_SILENCE);
        for (let i = 0; i < 200 && !readFile(`${this.dir}/port`); i++)
            GLib.usleep(25000);
        this.port = Number(readFile(`${this.dir}/port`));
        if (!this.port)
            throw new Error('fakeApi did not start');
        this.base = `http://127.0.0.1:${this.port}`;
        this.session = new Soup.Session({timeout: 10});
    }

    request(method, path, body) {
        const m = Soup.Message.new(method, `${this.base}${path}`);
        if (body)
            m.set_request_body_from_bytes('application/json', new GLib.Bytes(enc.encode(JSON.stringify(body))));
        const b = this.session.send_and_read(m, null);
        return JSON.parse(dec.decode(b.get_data()));
    }

    account(a, usage = undefined) {
        return this.request('POST', '/__admin/account', usage ? {...a, usage} : a);
    }

    issue(uuid, expiresIn) {
        return this.request('POST', '/__admin/issue', {uuid, expiresIn});
    }

    state() {
        return this.request('GET', '/__admin/state');
    }

    scenario(obj) {
        writeFile(`${this.dir}/scenario.json`, JSON.stringify(obj ?? {}));
    }

    issuedTokens() {
        return (readFile(`${this.dir}/issued-tokens.txt`) ?? '').split('\n').filter(Boolean);
    }

    stop() {
        this.proc.force_exit();
    }
}

export class Sandbox {
    constructor(api) {
        this.api = api;
        this.home = GLib.dir_make_tmp('cas-test-XXXXXX');
        assertSandboxPath(this.home);
        sandboxes.push(this);
        GLib.mkdir_with_parents(`${this.home}/.claude/projects/-home-user-proj`, 0o700);
        writeFile(`${this.home}/.claude/projects/-home-user-proj/1111.jsonl`,
            '{"type":"user","message":"hello"}\n{"type":"assistant","message":"how are you?"}\n');
        writeFile(`${this.home}/.claude/history.jsonl`, '{"display":"/status"}\n');
        writeFile(`${this.home}/.claude.json`, `${JSON.stringify({
            numStartups: 42,
            projects: {'/home/user/proj': {allowedTools: [], history: ['a', 'b'], mcpServers: {}}},
            mcpServers: {local: {command: 'x'}},
            userID: 'u-123',
            tipsHistory: {a: 1},
        }, null, 2)}\n`);
    }

    get env() {
        return {
            PATH: GLib.getenv('PATH'),
            HOME: this.home,
            LANG: 'C.UTF-8',
            CLAUDE_ACCOUNTS_TESTING: '1',
            CLAUDE_ACCOUNTS_NO_BROWSER: '1',
            CLAUDE_ACCOUNTS_API_BASE: this.api.base,
            CLAUDE_ACCOUNTS_TOKEN_URL: `${this.api.base}/v1/oauth/token`,
        };
    }

    path(rel) {
        return `${this.home}/${rel}`;
    }

    /** Spawn with a minimal environment (nothing from the real session leaks in). */
    spawn(argv, extraEnv = {}, flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE) {
        assertSandboxPath(this.home);
        const launcher = new Gio.SubprocessLauncher({flags});
        launcher.set_environ(Object.entries({...this.env, ...extraEnv}).map(([k, v]) => `${k}=${v}`));
        launcher.set_cwd(this.home);
        return launcher.spawnv(argv);
    }

    /** Run the engine; returns {status, stdout, stderr, json, lines}. */
    run(args, extraEnv = {}, {timeoutS = 120} = {}) {
        const argv = ['gjs', '-m', ENGINE, ...args, '--json', '--claude-path', FAKE_CLAUDE];
        const p = this.spawn(argv, extraEnv);
        const loop = new GLib.MainLoop(null, false);
        let out = '', err = '';
        const timer = GLib.timeout_add_seconds(0, timeoutS, () => {
            p.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        p.communicate_utf8_async(null, null, (pp, res) => {
            [, out, err] = pp.communicate_utf8_finish(res);
            loop.quit();
        });
        loop.run();
        GLib.source_remove(timer);
        p.wait(null);
        transcript.push(out, err);
        const lines = out.split('\n').filter(Boolean);
        let json = null;
        try {
            json = JSON.parse(lines[lines.length - 1]);
        } catch {}
        return {status: p.get_exit_status(), stdout: out, stderr: err, json, lines};
    }

    /** Make `acct` the live Claude Code login (as if the user ran /login). */
    login(acct, {expiresIn} = {}) {
        this.api.account(acct);
        const t = this.api.issue(acct.uuid, expiresIn);
        writeFile(this.path('.claude/.credentials.json'), `${JSON.stringify({
            claudeAiOauth: {
                accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt,
                refreshTokenExpiresAt: t.refreshTokenExpiresAt, scopes: ['user:inference', 'user:profile'],
                subscriptionType: 'max', rateLimitTier: 'default',
            },
            mcpOAuth: {'srv|1': {accessToken: 'mcp-machine-secret', serverName: 'srv'}},
        }, null, 2)}\n`);
        const cfg = readJson(this.path('.claude.json'));
        cfg.oauthAccount = {
            accountUuid: acct.uuid, emailAddress: acct.email, organizationUuid: acct.orgUuid,
            organizationName: acct.orgName, displayName: acct.email.split('@')[0],
        };
        writeFile(this.path('.claude.json'), `${JSON.stringify(cfg, null, 2)}\n`);
        return t;
    }

    /** Add an account through the isolated-login flow (fake claude). */
    addViaLogin(acct, extra = {}) {
        this.api.account(acct);
        return this.run(['add', '--login'], {FAKE_LOGIN_ACCOUNT: acct.uuid, FAKE_LOGIN_DELAY_MS: '50', ...extra});
    }

    liveCred() {
        return readJson(this.path('.claude/.credentials.json'));
    }

    liveAccount() {
        return readJson(this.path('.claude.json'))?.oauthAccount ?? null;
    }

    slotCred(uuid) {
        return readJson(this.path(`.local/share/claude-accounts/accounts/${uuid}/.credentials.json`));
    }

    registry() {
        return readJson(this.path('.local/share/claude-accounts/registry.json'));
    }

    stash() {
        const d = this.path('.local/share/claude-accounts/stash');
        const out = [];
        try {
            const en = Gio.File.new_for_path(d).enumerate_children('standard::name', 0, null);
            let i;
            while ((i = en.next_file(null)))
                out.push(i.get_name());
        } catch {}
        return out.sort();
    }

    /** sha256 of every file under ~/.claude except the credentials file. */
    claudeTreeHashes() {
        const out = {};
        const walk = (dir, rel) => {
            let en;
            try {
                en = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::type', 0, null);
            } catch {
                return;
            }
            let i;
            while ((i = en.next_file(null))) {
                const name = i.get_name();
                const p = `${dir}/${name}`;
                if (i.get_file_type() === Gio.FileType.DIRECTORY)
                    walk(p, `${rel}${name}/`);
                else if (`${rel}${name}` !== '.credentials.json')
                    out[`${rel}${name}`] = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, readFile(p) ?? '', -1);
            }
        };
        walk(this.path('.claude'), '');
        return out;
    }

    /** ~/.claude.json without oauthAccount. */
    configWithoutAccount() {
        const c = readJson(this.path('.claude.json'));
        delete c.oauthAccount;
        return c;
    }

    cleanup() {
        GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(this.home)}`);
    }
}

let shared = null;
/** One fake API process for the whole run. */
export function sharedApi() {
    shared ??= new FakeApi();
    return shared;
}

/** Stop fakes and remove sandboxes (keeps them with CLAUDE_ACCOUNTS_KEEP_SANDBOX=1). */
export function shutdown() {
    shared?.stop();
    if (GLib.getenv('CLAUDE_ACCOUNTS_KEEP_SANDBOX') !== '1') {
        for (const sb of sandboxes)
            sb.cleanup();
        if (shared)
            GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(shared.dir)}`);
    }
}
