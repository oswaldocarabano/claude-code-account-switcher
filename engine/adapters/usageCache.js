// ~/.cache/claude-accounts/usage.json: last usage per account and the polling state
// shared by every process (extension, terminal). Never contains tokens.

import {readText, writeJson, ensureDir} from './atomicFile.js';
import {parseObject} from '../domain/credential.js';

export function loadUsageCache(paths) {
    const c = parseObject(readText(paths.usageCache));
    if (!c || c.schemaVersion !== 1 || typeof c.accounts !== 'object')
        return {schemaVersion: 1, accounts: {}};
    return c;
}

export function saveUsageCache(paths, cache) {
    ensureDir(paths.cacheDir);
    writeJson(paths.usageCache, cache);
}

/** Read-modify-write merge of the entries this process updated. */
export function mergeUsageCache(paths, updates) {
    const cache = loadUsageCache(paths);
    for (const [uuid, entry] of Object.entries(updates))
        cache.accounts[uuid] = entry;
    saveUsageCache(paths, cache);
    return cache;
}
