// Claude Code's live files: <config>/.credentials.json and the oauthAccount
// block of the global config. Only these two things are ever written
// (every other key of ~/.claude.json is preserved as-is).

import {readText, writeAtomic, stringifyStrict, exists} from './atomicFile.js';
import {parseObject} from '../domain/credential.js';

/**
 * Coherent read: credentials, config, credentials again; retry if Claude Code
 * was writing in between.
 */
export function readLive(paths) {
    let credText, configText;
    for (let i = 0; i < 3; i++) {
        credText = readText(paths.credentials);
        configText = readText(paths.globalConfig);
        if (readText(paths.credentials) === credText)
            break;
    }
    const cred = parseObject(credText);
    const config = parseObject(configText);
    const account = config?.oauthAccount && typeof config.oauthAccount === 'object'
        ? config.oauthAccount : null;
    return {
        credText,
        cred,
        configText,
        configReadable: configText === null || config !== null,
        account,
    };
}

export function writeLiveCredentials(paths, cred) {
    writeAtomic(paths.credentials, stringifyStrict(cred));
}

/**
 * Replace only oauthAccount in the global config. If the file cannot be parsed
 * its bytes are handed to `stashBytes` first and a minimal config is written.
 */
export function writeLiveAccount(paths, account, stashBytes) {
    const text = readText(paths.globalConfig);
    const config = parseObject(text);
    if (config) {
        config.oauthAccount = account;
        writeAtomic(paths.globalConfig, stringifyStrict(config));
        return;
    }
    if (text !== null)
        stashBytes(text);
    writeAtomic(paths.globalConfig, stringifyStrict({oauthAccount: account}));
}

/** Restore exact bytes (rollback). null means the file did not exist. */
export function restoreBytes(path, text, removeFile) {
    if (text === null) {
        if (exists(path))
            removeFile(path);
        return;
    }
    writeAtomic(path, text);
}
