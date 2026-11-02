// `claude-accounts switch --best`: the switchable account with the most
// headroom on its binding window.

import {headroom} from './usage.js';

/**
 * @param {object[]} accounts registry entries
 * @param {Map<string, object|null>} usageByUuid estimated usage per account
 * @param {string|null} activeUuid
 * @returns {object|null}
 */
export function pickBest(accounts, usageByUuid, activeUuid) {
    const candidates = accounts.filter(a =>
        a.uuid !== activeUuid && !a.disabled && a.state !== 'needs-login');
    if (!candidates.length)
        return null;
    const scored = candidates.map(a => ({a, h: headroom(usageByUuid.get(a.uuid))}));
    scored.sort((x, y) => {
        if (x.h === null && y.h === null)
            return x.a.number - y.a.number;
        if (x.h === null)
            return 1;
        if (y.h === null)
            return -1;
        return y.h - x.h || x.a.number - y.a.number;
    });
    return scored[0].a;
}
