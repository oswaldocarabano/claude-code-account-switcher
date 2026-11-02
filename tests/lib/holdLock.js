// Helper process: acquire a lock with the engine's protocol, hold it, release.
//   gjs -m tests/lib/holdLock.js <path> <staleMs> <holdMs> [touch]
import GLib from 'gi://GLib';
import {acquire} from '../../engine/adapters/lock.js';

const [path, staleMs, holdMs, touch] = ARGV;
const h = acquire({path, staleMs: Number(staleMs), timeoutMs: 30000});
GLib.file_set_contents(`${path}.acquired`, String(Date.now()));
const end = Date.now() + Number(holdMs);
while (Date.now() < end) {
    GLib.usleep(200000);
    if (touch)
        h.touch();
}
h.release();
