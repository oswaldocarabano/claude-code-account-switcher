// store.js with a fake engine client: queue, busy flag,
// debounce of the credentials monitor and threshold warnings once per window.

import GLib from 'gi://GLib';
import {suite, test, assert} from '../lib/harness.js';
import {Store} from '../../extension/lib/store.js';
import {parseEngineOutput, EngineError} from '../../extension/lib/engineClient.js';

function settings(over = {}) {
    const v = {'refresh-interval': 180, 'warn-threshold': 80, 'notify-on-switch': true, 'activate-after-login': true, ...over};
    return {get_uint: k => v[k], get_boolean: k => v[k], get_string: k => v[k], connect: () => 1, disconnect: () => {}, set_boolean: (k, x) => (v[k] = x)};
}

/** Run the main loop until `cond()` or timeout. */
function spin(cond, ms = 3000) {
    const ctx = GLib.MainContext.default();
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) {
        if (!ctx.iteration(false))
            GLib.usleep(2000);
    }
    return cond();
}

const later = (ms, v) => new Promise(r => GLib.timeout_add(0, ms, () => {
    r(v);
    return GLib.SOURCE_REMOVE;
}));

function account(n, pct, resetsAt = '2999-01-01T00:00:00Z', active = false) {
    return {
        number: n, uuid: `u${n}`, email: `a${n}@x.com`, active, state: 'ok', disabled: false,
        usage: {fiveHour: {pct, resetsAt, estimated: false}},
    };
}

function fakeClient(script = {}) {
    const calls = [];
    return {
        calls,
        list(o) {
            calls.push(['list', o]);
            return later(script.listMs ?? 20, script.list?.() ?? {accounts: [account(1, 10, undefined, true), account(2, 5)], active: {capture: 'same'}});
        },
        switchTo(n) {
            calls.push(['switch', n]);
            return later(script.switchMs ?? 50, {switched: true, to: {email: `a${n}@x.com`}, verified: true, warnings: []});
        },
        switchBest() {
            calls.push(['best']);
            return later(10, {switched: false, reason: 'no-candidate'});
        },
        addCurrent() {
            calls.push(['add']);
            return later(10, {added: true, account: {email: 'new@x.com'}});
        },
    };
}

suite('extension store');

test('refreshes are dropped while busy; switch and add queue up in order', () => {
    const c = fakeClient({switchMs: 120});
    const s = new Store(c, settings(), {timers: false});
    let done = 0;
    s.switchTo(2).then(() => done++);
    s.refresh(); // dropped: busy with the switch
    s.addCurrent().then(() => done++);
    assert.ok(spin(() => done === 2));
    const ops = c.calls.map(x => x[0]);
    assert.deepEqual(ops, ['switch', 'list', 'add', 'list'], JSON.stringify(c.calls));
    assert.ok(!s.busy && s.switching === null);
    s.destroy();
});

test('switch notifies once with the new account and refreshes from cache', () => {
    const c = fakeClient();
    const s = new Store(c, settings(), {timers: false});
    const notes = [];
    s.connect('notify', (_s, n) => notes.push(n));
    let ok = false;
    s.switchTo(2).then(() => (ok = true));
    assert.ok(spin(() => ok));
    assert.equal(notes.length, 1);
    assert.ok(notes[0].title.includes('a2@x.com'));
    assert.deepEqual(c.calls.at(-1), ['list', {cached: true}]);
    s.destroy();
});

test('no notification on switch when notify-on-switch is off', () => {
    const s = new Store(fakeClient(), settings({'notify-on-switch': false}), {timers: false});
    const notes = [];
    s.connect('notify', (_s, n) => notes.push(n));
    let ok = false;
    s.switchTo(2).then(() => (ok = true));
    spin(() => ok);
    assert.equal(notes.length, 0);
    s.destroy();
});

test('threshold warning fires once per window, again for a new window', () => {
    let reset = '2999-01-01T00:00:00Z';
    let pct = 85;
    const c = fakeClient({list: () => ({accounts: [account(1, pct, reset, true), account(2, 3)], active: {capture: 'same'}})});
    const s = new Store(c, settings(), {timers: false});
    const notes = [];
    s.connect('notify', (_s, n) => notes.push(n));
    const refresh = () => {
        let ok = false;
        s.refresh().then(() => (ok = true));
        spin(() => ok);
    };
    refresh();
    refresh();
    assert.equal(notes.length, 1, 'once per window');
    assert.ok(notes[0].body.includes('a2@x.com'), 'suggests the freest account');
    reset = '2999-01-02T00:00:00Z';
    refresh();
    assert.equal(notes.length, 2, 'new window, new warning');
    pct = 50;
    reset = '2999-01-03T00:00:00Z';
    refresh();
    assert.equal(notes.length, 2, 'below threshold: silent');
    s.destroy();
});

test('credential changes are debounced into a single cached refresh', () => {
    const c = fakeClient();
    const s = new Store(c, settings(), {timers: false});
    for (let i = 0; i < 10; i++)
        s.credentialsChanged();
    spin(() => false, 2600);
    const lists = c.calls.filter(x => x[0] === 'list');
    assert.equal(lists.length, 1);
    assert.equal(lists[0][1].cached, true);
    s.destroy();
});

test('a credential change reads usage at once when it was waiting for Claude Code', () => {
    const waiting = account(1, 10, undefined, true);
    waiting.usageError = 'active-expired';
    const c = fakeClient({list: () => ({accounts: [waiting], active: {capture: 'same'}})});
    const s = new Store(c, settings(), {timers: false});
    s.credentialsChanged();
    spin(() => c.calls.filter(x => x[0] === 'list').length >= 2, 4000);
    const lists = c.calls.filter(x => x[0] === 'list');
    assert.equal(lists.length, 2);
    assert.equal(lists[0][1].cached, true);
    assert.equal(lists[1][1].cached, false);
    s.destroy();
});

test('destroy removes sources and handlers; later events are ignored', () => {
    const c = fakeClient();
    const s = new Store(c, settings(), {timers: false});
    s.credentialsChanged();
    s.destroy();
    spin(() => false, 2300);
    assert.equal(c.calls.length, 0);
});

test('engine output: schemaVersion is enforced and errors carry their kind', () => {
    assert.equal(parseEngineOutput('{"schemaVersion":1,"accounts":[]}').accounts.length, 0);
    let e = null;
    try {
        parseEngineOutput('{"schemaVersion":2}');
    } catch (x) {
        e = x;
    }
    assert.ok(e instanceof EngineError && e.kind === 'schema');
    try {
        parseEngineOutput('{"schemaVersion":1,"error":{"kind":"needs-login","message":"sk-ant-oat01-SECRETxyz"}}');
    } catch (x) {
        e = x;
    }
    assert.equal(e.kind, 'needs-login');
    assert.ok(!e.message.includes('SECRET'), 'redacted');
    try {
        parseEngineOutput('not json');
    } catch (x) {
        e = x;
    }
    assert.equal(e.kind, 'bad-output');
});
