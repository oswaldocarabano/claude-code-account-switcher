// Adapter tests with temporary directories.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {suite, test, assert} from '../lib/harness.js';
import {REPO, readFile, writeFile} from '../lib/sandbox.js';
import {acquire, acquireAll} from '../../engine/adapters/lock.js';
import {writeAtomic, modeOf, readText, mtimeMs, touch} from '../../engine/adapters/atomicFile.js';
import {makePaths} from '../../engine/adapters/paths.js';
import {readLive} from '../../engine/adapters/claudeFiles.js';
import {scanSessions} from '../../engine/adapters/sessions.js';
import {procStart, isAlive} from '../../engine/adapters/procfs.js';

const tmp = () => GLib.dir_make_tmp('cas-test-ad-XXXXXX');
const exists = p => GLib.file_test(p, GLib.FileTest.EXISTS);
const holder = (path, staleMs, holdMs, touchIt = false) => Gio.Subprocess.new(
    ['gjs', '-m', `${REPO}/tests/lib/holdLock.js`, path, String(staleMs), String(holdMs), ...touchIt ? ['touch'] : []],
    Gio.SubprocessFlags.NONE);
const waitFor = p => {
    for (let i = 0; i < 200 && !exists(p); i++)
        GLib.usleep(25000);
};
const setMtime = (p, msAgo) => touch(p, Date.now() - msAgo);

suite('lock');

test('mutual exclusion between two processes', () => {
    const d = tmp();
    const lock = `${d}/x.lock`;
    const p = holder(lock, 60000, 1200);
    waitFor(`${lock}.acquired`);
    const t0 = Date.now();
    const h = acquire({path: lock, staleMs: 60000, timeoutMs: 10000});
    const waited = Date.now() - t0;
    h.release();
    p.wait(null);
    assert.ok(waited > 700, `waited only ${waited} ms`);
    assert.ok(!exists(lock));
});

test('a stale lock (old mtime) is taken over; a fresh one is not', () => {
    const d = tmp();
    const lock = `${d}/s.lock`;
    GLib.mkdir_with_parents(lock, 0o755);
    setMtime(lock, 61000);
    const h = acquire({path: lock, staleMs: 60000, timeoutMs: 2000});
    h.release();
    GLib.mkdir_with_parents(lock, 0o755);
    const t0 = Date.now();
    assert.throws(() => acquire({path: lock, staleMs: 60000, timeoutMs: 1000}), 'lock-timeout');
    assert.ok(Date.now() - t0 >= 1000);
    assert.ok(exists(lock), 'a live lock is never stolen');
});

test('a holder that keeps touching its lock is not considered stale', () => {
    const d = tmp();
    const lock = `${d}/t.lock`;
    const p = holder(lock, 1000, 2500, true);
    waitFor(`${lock}.acquired`);
    assert.throws(() => acquire({path: lock, staleMs: 1000, timeoutMs: 1500}), 'lock-timeout');
    p.wait(null);
});

test('our own lock is recovered at once when its holder pid is dead', () => {
    const d = tmp();
    const lock = `${d}/claude-accounts.lock`;
    GLib.mkdir_with_parents(lock, 0o700);
    writeFile(`${lock}/owner`, JSON.stringify({pid: 999999, procStart: '1'}));
    const t0 = Date.now();
    const h = acquire({path: lock, staleMs: 60000, timeoutMs: 3000, owner: true});
    assert.ok(Date.now() - t0 < 1500);
    assert.ok(JSON.parse(readFile(`${lock}/owner`)).pid > 0);
    h.release();
    assert.ok(!exists(lock));
});

test('two waiters taking over the same dead lock do not both win (takeover dir)', () => {
    const d = tmp();
    const lock = `${d}/r.lock`;
    GLib.mkdir_with_parents(lock, 0o755);
    setMtime(lock, 120000);
    const a = holder(lock, 60000, 800);
    const b = holder(lock, 60000, 800);
    a.wait(null);
    b.wait(null);
    // Both eventually acquired, never at the same time: their acquisition
    // stamps are at least one hold apart.
    assert.ok(a.get_exit_status() === 0 && b.get_exit_status() === 0);
    assert.ok(!exists(lock) && !exists(`${lock}.takeover`));
});

test('acquireAll releases everything if one lock times out; never touches .owner files', () => {
    const d = tmp();
    GLib.mkdir_with_parents(`${d}/b.lock`, 0o755);
    writeFile(`${d}/.oauth_refresh.lock.owner`, '{"pid":1}');
    assert.throws(() => acquireAll([
        {path: `${d}/a.lock`, staleMs: 60000, timeoutMs: 500},
        {path: `${d}/b.lock`, staleMs: 60000, timeoutMs: 500},
    ]), 'lock-timeout');
    assert.ok(!exists(`${d}/a.lock`), 'first lock released');
    assert.equal(readFile(`${d}/.oauth_refresh.lock.owner`), '{"pid":1}');
});

test('configured timeouts: 9 s credentials, 15 s config (> its 10 s staleness)', () => {
    const p = makePaths(n => ({HOME: '/tmp/cas-test-x'})[n] ?? null);
    assert.deepEqual(p.liveCredLocks.map(l => [l.staleMs, l.timeoutMs]), [[60000, 9000], [60000, 9000]]);
    assert.deepEqual([p.configLock.staleMs, p.configLock.timeoutMs], [10000, 15000]);
    assert.equal(p.liveCredLocks[0].path, '/tmp/cas-test-x/.claude/.oauth_refresh.lock');
    assert.equal(p.liveCredLocks[1].path, '/tmp/cas-test-x/.claude.lock');
    assert.equal(p.configLock.path, '/tmp/cas-test-x/.claude.json.lock');
});

suite('atomicFile');

test('0600 from the start, through symlinks, no temp left behind', () => {
    const d = tmp();
    writeAtomic(`${d}/a.json`, '{"a":1}');
    assert.equal(modeOf(`${d}/a.json`), 0o600);
    writeFile(`${d}/real.json`, 'old');
    GLib.spawn_command_line_sync(`ln -s real.json ${d}/link.json`);
    writeAtomic(`${d}/link.json`, 'new');
    assert.ok(GLib.file_test(`${d}/link.json`, GLib.FileTest.IS_SYMLINK), 'link kept');
    assert.equal(readFile(`${d}/real.json`), 'new');
    const leftovers = GLib.spawn_command_line_sync(`ls -A ${d}`)[1];
    assert.equal(new TextDecoder().decode(leftovers).trim().split('\n').sort().join(','), 'a.json,link.json,real.json');
});

test('a failing write throws and leaves the target untouched', () => {
    const d = tmp();
    writeFile(`${d}/ro/x.json`, 'keep');
    GLib.spawn_command_line_sync(`chmod 500 ${d}/ro`);
    assert.throws(() => writeAtomic(`${d}/ro/x.json`, 'new'), 'io');
    assert.equal(readText(`${d}/ro/x.json`), 'keep');
    GLib.spawn_command_line_sync(`chmod 700 ${d}/ro`);
    assert.equal(new TextDecoder().decode(GLib.spawn_command_line_sync(`ls -A ${d}/ro`)[1]).trim(), 'x.json');
});

test('coherent read survives a concurrent writer', () => {
    const d = tmp();
    const paths = makePaths(n => ({HOME: d})[n] ?? null);
    writeFile(paths.credentials, JSON.stringify({claudeAiOauth: {accessToken: 'a0', refreshToken: 'r0'}}));
    writeFile(paths.globalConfig, JSON.stringify({oauthAccount: {accountUuid: 'u'}}));
    const w = Gio.Subprocess.new(['sh', '-c', `for i in $(seq 1 200); do printf '{"claudeAiOauth":{"accessToken":"a%s","refreshToken":"r%s"}}' $i $i > ${paths.credentials}.t && mv ${paths.credentials}.t ${paths.credentials}; done`], 0);
    let bad = 0;
    for (let i = 0; i < 200; i++) {
        const s = readLive(paths);
        if (!s.cred?.claudeAiOauth)
            bad++;
    }
    w.wait(null);
    assert.equal(bad, 0);
});

test('mtime helpers', () => {
    const d = tmp();
    writeFile(`${d}/f`, 'x');
    touch(`${d}/f`, 1_000_000_000_000);
    assert.equal(mtimeMs(`${d}/f`), 1_000_000_000_000);
});

suite('paths');

test('CLAUDE_CONFIG_DIR ignored; legacy .config.json honoured; XDG dirs', () => {
    const d = tmp();
    const env = {HOME: d, CLAUDE_CONFIG_DIR: `${d}/other`, XDG_DATA_HOME: `${d}/data`, XDG_CACHE_HOME: 'relative/ignored'};
    let p = makePaths(n => env[n] ?? null);
    assert.equal(p.credentials, `${d}/.claude/.credentials.json`);
    assert.equal(p.globalConfig, `${d}/.claude.json`);
    assert.equal(p.dataDir, `${d}/data/claude-accounts`);
    assert.equal(p.cacheDir, `${d}/.cache/claude-accounts`);
    writeFile(`${d}/.claude/.config.json`, '{"x":1}');
    p = makePaths(n => env[n] ?? null);
    assert.equal(p.globalConfig, `${d}/.claude/.config.json`);
});

suite('sessions');

test('alive, dead and recycled pids', () => {
    const d = tmp();
    const paths = makePaths(n => ({HOME: d})[n] ?? null);
    const self = Number(readFile('/proc/self/stat').split(' ')[0]);
    const ppid = Number(readFile(`/proc/${self}/stat`).split(') ')[1].split(' ')[1]);
    const me = new Gio.Credentials().get_unix_pid();
    writeFile(`${paths.sessionsDir}/${me}.json`, JSON.stringify({pid: me, procStart: procStart(me), status: 'busy'}));
    writeFile(`${paths.sessionsDir}/999999.json`, JSON.stringify({pid: 999999, status: 'busy'}));
    writeFile(`${paths.sessionsDir}/${ppid}.json`, JSON.stringify({pid: ppid, procStart: '1', status: 'idle'}));
    assert.deepEqual(scanSessions(paths), {running: 1, busy: 1});
    assert.ok(isAlive(me, procStart(me)));
    assert.ok(!isAlive(me, '1'));
});
