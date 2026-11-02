// Running Claude Code instances from <config>/sessions/{pid}.json.
// Read-only.

import {listDir, readText} from './atomicFile.js';
import {parseObject} from '../domain/credential.js';
import {isAlive} from './procfs.js';

export function scanSessions(paths) {
    let running = 0, busy = 0;
    for (const name of listDir(paths.sessionsDir)) {
        if (!/^\d+\.json$/.test(name))
            continue;
        const s = parseObject(readText(`${paths.sessionsDir}/${name}`));
        const pid = Number(s?.pid ?? name.slice(0, -5));
        if (!isAlive(pid, s?.procStart ?? null))
            continue;
        running++;
        if (s?.status === 'busy' || s?.status === 'waiting')
            busy++;
    }
    return {running, busy};
}
