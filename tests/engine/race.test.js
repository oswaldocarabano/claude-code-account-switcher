// Race tests: switching while a running Claude Code keeps rotating the live
// token under its own locks. Invariant: no account ever ends up
// holding a refresh token the server already invalidated.

import Gio from 'gi://Gio';
import {suite, test, assert} from '../lib/harness.js';
import {REPO, sharedApi, Sandbox, ACCOUNTS} from '../lib/sandbox.js';

const {A, B} = ACCOUNTS;

suite('race');

test('1 000 Claude Code rotations during repeated switches: no account loses its login', () => {
    const api = sharedApi();
    api.scenario({});
    const sb = new Sandbox(api);
    sb.login(A);
    assert.equal(sb.run(['add', '--current']).status, 0);
    assert.equal(sb.addViaLogin(B).status, 0);

    const cc = sb.spawn(['gjs', '-m', `${REPO}/tests/fakeClaudeCode.js`, '--rotations', '1000', '--sleep-ms', '12'],
        {}, Gio.SubprocessFlags.STDOUT_PIPE);
    let switches = 0, busy = 0;
    for (let i = 0; i < 40; i++) {
        const target = switches % 2 === 0 ? '2' : '1';
        const r = sb.run(['switch', target]);
        if (r.json?.switched)
            switches++;
        else if (r.json?.error?.kind === 'lock-timeout')
            busy++;
        else
            assert.ok(r.json?.reason === 'already-active', `unexpected: ${r.stdout}${r.stderr}`);
    }
    const [, out] = cc.communicate_utf8(null, null);
    const stats = JSON.parse(out.trim().split('\n').at(-1));
    assert.equal(stats.rotations, 1000, out);
    assert.equal(stats.failures, 0, 'Claude Code never hit invalid_grant');
    assert.ok(switches >= 30, `only ${switches} switches (busy ${busy})`);

    // Final check: the stored generation of every account is still valid.
    sb.run(['list', '--cached']); // capture the last rotation into the active slot
    const valid = api.state().validRefresh;
    const live = sb.liveCred().claudeAiOauth.refreshToken;
    const activeUuid = sb.liveAccount().accountUuid;
    for (const acct of [A, B]) {
        const held = acct.uuid === activeUuid ? live : sb.slotCred(acct.uuid).claudeAiOauth.refreshToken;
        assert.ok((valid[acct.uuid] ?? []).includes(held), `${acct.email} holds a spent refresh token`);
        if (acct.uuid === activeUuid)
            assert.equal(sb.slotCred(acct.uuid).claudeAiOauth.refreshToken, live, 'active slot follows live');
    }
    print(`      (${switches} switches, ${busy} lock retries, 1000 rotations)`);
}, {slow: true});
