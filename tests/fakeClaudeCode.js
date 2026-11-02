// Imitates a running Claude Code refreshing the LIVE credential, with its lock
// protocol: .oauth_refresh.lock, then <config>.lock; read,
// refresh over the network, write, release. Used for the race tests.
//
//   gjs -m tests/fakeClaudeCode.js --rotations N [--sleep-ms M]
// Prints {"rotations": n, "failures": n} — a failure is an invalid_grant,
// i.e. the live credential carried a refresh token that was already spent.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const rotations = Number(ARGV[ARGV.indexOf('--rotations') + 1] ?? 10);
const sleepMs = ARGV.includes('--sleep-ms') ? Number(ARGV[ARGV.indexOf('--sleep-ms') + 1]) : 5;
const home = GLib.getenv('HOME');
const cfg = `${home}/.claude`;
const credPath = `${cfg}/.credentials.json`;
const tokenUrl = GLib.getenv('CLAUDE_ACCOUNTS_TOKEN_URL');
const session = new Soup.Session({timeout: 10});
const dec = new TextDecoder();

function tryMkdir(p) {
    try {
        Gio.File.new_for_path(p).make_directory(null);
        return true;
    } catch {
        return false;
    }
}

function rmdir(p) {
    try {
        Gio.File.new_for_path(p).delete(null);
    } catch {}
}

function acquire() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (tryMkdir(`${cfg}/.oauth_refresh.lock`)) {
            if (tryMkdir(`${cfg}.lock`))
                return true;
            rmdir(`${cfg}/.oauth_refresh.lock`); // like CC: release primary on legacy contention
        }
        GLib.usleep(3000 + Math.floor(Math.random() * 4000));
    }
    return false;
}

function release() {
    rmdir(`${cfg}.lock`);
    rmdir(`${cfg}/.oauth_refresh.lock`);
}

let done = 0, failures = 0;
for (let i = 0; i < rotations; i++) {
    if (!acquire()) {
        failures++;
        continue;
    }
    try {
        const cred = JSON.parse(dec.decode(GLib.file_get_contents(credPath)[1]));
        const o = cred.claudeAiOauth;
        const m = Soup.Message.new('POST', tokenUrl);
        m.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(
            JSON.stringify({grant_type: 'refresh_token', refresh_token: o.refreshToken}))));
        const body = JSON.parse(dec.decode(session.send_and_read(m, null).get_data()));
        if (m.status_code === 200) {
            o.accessToken = body.access_token;
            o.refreshToken = body.refresh_token;
            o.expiresAt = Date.now() + body.expires_in * 1000;
            GLib.file_set_contents_full(credPath, new TextEncoder().encode(JSON.stringify(cred, null, 2)),
                GLib.FileSetContentsFlags.CONSISTENT, 0o600);
            done++;
        } else {
            failures++;
            printerr(`invalid_grant at rotation ${i}`);
        }
    } finally {
        release();
    }
    GLib.usleep(Math.floor(Math.random() * sleepMs * 2000));
}
print(JSON.stringify({rotations: done, failures}));
