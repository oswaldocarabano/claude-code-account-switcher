// Runs last: no issued token may appear in any engine output or log
// stash/ and accounts/ are secret storage and are excluded.

import GLib from 'gi://GLib';
import {suite, test, assert} from '../lib/harness.js';
import {sharedApi, transcript, sandboxes, readFile} from '../lib/sandbox.js';

suite('leaks');

test('no token in stdout/stderr of any run nor in claude-accounts.log', () => {
    const tokens = sharedApi().issuedTokens();
    assert.ok(tokens.length > 10, 'the suite issued tokens');
    const haystacks = [...transcript];
    for (const sb of sandboxes) {
        for (const f of ['claude-accounts.log', 'claude-accounts.log.1', 'claude-accounts.log.2'])
            haystacks.push(readFile(sb.path(`.local/state/claude-accounts/${f}`)) ?? '');
        haystacks.push(readFile(sb.path('.cache/claude-accounts/usage.json')) ?? '');
        haystacks.push(readFile(sb.path('.local/share/claude-accounts/registry.json')) ?? '');
    }
    const all = haystacks.join('\n');
    const leaked = tokens.filter(t => all.includes(t));
    assert.equal(leaked.length, 0, `${leaked.length} tokens leaked`);
    assert.ok(!/sk-ant-o[ar]t01-FAKE/.test(all), 'no token prefix in outputs');
    assert.ok(all.length > 1000, 'transcript captured');
    void GLib;
});
