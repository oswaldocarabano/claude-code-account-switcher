// Classification of the live session against the saved accounts.
// Pure: the caller provides the parsed live credential, oauthAccount and slots.

import {
    oauthOf, isWiped, hasTokens, refreshFp, expiresAt, sameAccountContent,
} from './credential.js';

/** Kinds that need no write at all. */
export const PASSIVE_KINDS = new Set(['none', 'unmanaged', 'same']);

/**
 * Find the registry entry for an oauthAccount block: by accountUuid, falling
 * back to email + organizationUuid together.
 */
export function findAccountFor(registry, oauthAccount) {
    if (!oauthAccount)
        return null;
    const uuid = oauthAccount.accountUuid;
    if (uuid) {
        const byUuid = registry.accounts.find(a => a.uuid === uuid);
        if (byUuid)
            return byUuid;
    }
    const email = oauthAccount.emailAddress;
    const org = oauthAccount.organizationUuid;
    if (email && org)
        return registry.accounts.find(a => a.email === email && a.orgUuid === org) ?? null;
    return null;
}

/**
 * Local (no network) classification.
 *
 * @param {object} p
 * @param {object|null} p.live parsed live credential
 * @param {object|null} p.liveAccount live oauthAccount block
 * @param {{accounts: object[]}} p.registry
 * @param {Map<string, object|null>} p.slotCreds uuid -> saved credential
 * @returns {{kind: string, account?: object, foreign?: object}}
 */
export function classifyLocal({live, liveAccount, registry, slotCreds}) {
    if (!live || !oauthOf(live))
        return {kind: 'none'};
    const account = findAccountFor(registry, liveAccount);
    if (isWiped(live) || !hasTokens(live))
        return {kind: 'wiped', account};
    if (!account)
        return {kind: 'unmanaged'};

    const saved = slotCreds.get(account.uuid) ?? null;
    if (saved && sameAccountContent(live, saved))
        return {kind: 'same', account};

    const fpLive = refreshFp(live);
    if (saved && fpLive === refreshFp(saved)) {
        return expiresAt(live) > expiresAt(saved)
            ? {kind: 'newer', account}
            : {kind: 'same', account};
    }

    // Lineage differs. If another saved account already holds it, the live
    // credential is that account's and ~/.claude.json is out of date.
    for (const other of registry.accounts) {
        if (other.uuid === account.uuid)
            continue;
        const c = slotCreds.get(other.uuid);
        if (c && refreshFp(c) === fpLive)
            return {kind: 'foreign', account, foreign: other};
    }
    return {kind: 'rotated', account};
}

/**
 * Resolve a 'rotated' classification with the /api/oauth/profile answer.
 *
 * @param {{kind: string, account: object}} local
 * @param {{uuid: string}|null} profile null = no answer (offline/error)
 * @param {{accounts: object[]}} registry
 */
export function resolveRotated(local, profile, registry) {
    if (local.kind !== 'rotated')
        return local;
    if (!profile?.uuid)
        return {kind: 'rotated-unverified', account: local.account};
    if (profile.uuid === local.account.uuid)
        return {kind: 'rotated-own', account: local.account};
    const other = registry.accounts.find(a => a.uuid === profile.uuid);
    if (other)
        return {kind: 'foreign', account: local.account, foreign: other};
    return {kind: 'alien', account: local.account};
}

/** What the store has to do for a resolved kind. */
export function captureAction(kind) {
    switch (kind) {
    case 'newer':
        return {copyToSlot: true, stashPrevious: false, state: 'ok'};
    case 'rotated-own':
        return {copyToSlot: true, stashPrevious: true, state: 'ok'};
    case 'rotated-unverified':
        return {copyToSlot: true, stashPrevious: true, state: 'unverified'};
    case 'foreign':
    case 'alien':
        return {stashLive: true};
    case 'wiped':
        return {markNeedsLogin: true};
    default:
        return {};
    }
}
