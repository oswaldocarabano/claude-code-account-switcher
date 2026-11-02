// Test entry point: gjs -m tests/run.js [--quick] [filter]
// Engine tests never touch the real ~/.claude: every end-to-end test runs in a
// temporary HOME under /tmp with a fake API and a fake `claude`.

import System from 'system';
import {runAll} from './lib/harness.js';
import {shutdown} from './lib/sandbox.js';
import './engine/domain.test.js';
import './engine/adapters.test.js';
import './engine/e2e.test.js';
import './engine/race.test.js';
import './extension/format.test.js';
import './extension/store.test.js';
import './engine/leaks.test.js';

const quick = ARGV.includes('--quick');
const filter = ARGV.find(a => !a.startsWith('--')) ?? null;
const ok = runAll({filter, skipSlow: quick});
shutdown();
System.exit(ok ? 0 : 1);
