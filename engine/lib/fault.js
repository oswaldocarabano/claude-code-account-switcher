// Fault injection for the rollback tests. Only active with
// CLAUDE_ACCOUNTS_TESTING=1 and CLAUDE_ACCOUNTS_FAULT=<point>; a no-op otherwise.

import GLib from 'gi://GLib';

export function fault(point) {
    if (GLib.getenv('CLAUDE_ACCOUNTS_TESTING') === '1' && GLib.getenv('CLAUDE_ACCOUNTS_FAULT') === point)
        throw new Error(`injected failure at ${point}`);
}
