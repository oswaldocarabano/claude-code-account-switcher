// Minimal test harness for gjs (no external dependencies).

const tests = [];
let current = '';

export function suite(name) {
    current = name;
}

export function test(name, fn, {slow = false} = {}) {
    tests.push({name: `${current} › ${name}`, fn, slow});
}

export class AssertionError extends Error {}

export const assert = {
    ok(v, msg = 'expected truthy') {
        if (!v)
            throw new AssertionError(msg);
    },
    equal(a, b, msg = '') {
        if (a !== b)
            throw new AssertionError(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    },
    deepEqual(a, b, msg = '') {
        const sa = JSON.stringify(a), sb = JSON.stringify(b);
        if (sa !== sb)
            throw new AssertionError(`${msg}\n  expected ${sb}\n  got      ${sa}`);
    },
    throws(fn, kind = null, msg = '') {
        try {
            fn();
        } catch (e) {
            if (kind && e.kind !== kind)
                throw new AssertionError(`${msg} expected error kind ${kind}, got ${e.kind ?? e.message}`);
            return e;
        }
        throw new AssertionError(`${msg} expected an exception`);
    },
};

export function runAll({filter = null, skipSlow = false} = {}) {
    let pass = 0, fail = 0, skipped = 0;
    const failures = [];
    for (const t of tests) {
        if ((filter && !t.name.includes(filter)) || (skipSlow && t.slow)) {
            skipped++;
            continue;
        }
        const t0 = Date.now();
        try {
            t.fn();
            pass++;
            print(`  ✓ ${t.name} (${Date.now() - t0} ms)`);
        } catch (e) {
            fail++;
            failures.push(t.name);
            print(`  ✗ ${t.name}\n      ${e.message}\n${(e.stack ?? '').split('\n').slice(0, 4).map(l => `      ${l}`).join('\n')}`);
        }
    }
    print(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
    if (failures.length)
        print(`Failed:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    return fail === 0;
}
