// Wiring of adapters for one engine invocation. Tests build their own context
// with a temporary HOME and fake endpoints.

import GLib from 'gi://GLib';
import {makePaths} from '../adapters/paths.js';
import {Store} from '../adapters/store.js';
import {Http, endpointsFromEnv} from '../adapters/http.js';
import {ClaudeCli, resolveClaude} from '../adapters/claudeCli.js';
import {Log} from '../adapters/log.js';
import {VERSION} from '../lib/version.js';

/**
 * @param {{command: string, claudePath?: string, refreshStrategy?: string,
 *          activeInterval?: number}} opts
 * @param {(name: string) => string|null} [env]
 */
export function makeContext(opts, env = n => GLib.getenv(n)) {
    const paths = makePaths(env);
    const endpoints = endpointsFromEnv(env);
    const clock = () => Date.now();
    return {
        paths,
        clock,
        testing: endpoints.testing,
        store: new Store(paths, clock),
        http: new Http({...endpoints, userAgent: `claude-accounts/${VERSION}`}),
        claude: new ClaudeCli(resolveClaude(opts.claudePath, paths)),
        log: new Log(paths, opts.command),
        strategy: opts.refreshStrategy === 'direct' ? 'direct' : 'delegate',
        activeIntervalS: opts.activeInterval,
        warnings: [],
    };
}
