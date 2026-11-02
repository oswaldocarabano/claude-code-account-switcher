// The engine's own data: registry.json, accounts/<uuid>/ (one CLAUDE_CONFIG_DIR per
// account, storage only), stash/ (never deleted automatically) and tmp/.

import GLib from 'gi://GLib';
import {
    readText, writeJson, writeAtomic, stringifyStrict, ensureDir, listDir, move,
    exists, removeTree,
} from './atomicFile.js';
import {parseObject, sha256, stripShared} from '../domain/credential.js';
import {EngineError} from '../lib/errors.js';
import {_, fmt} from '../lib/i18n.js';

export const REGISTRY_VERSION = 1;

function stamp(nowMs) {
    return new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

export class Store {
    constructor(paths, clock = () => Date.now()) {
        this.paths = paths;
        this.clock = clock;
    }

    ensure() {
        ensureDir(this.paths.dataDir);
        ensureDir(this.paths.accountsDir);
        ensureDir(this.paths.stashDir);
        ensureDir(this.paths.tmpDir);
    }

    loadRegistry() {
        const text = readText(this.paths.registry);
        if (text === null)
            return {schemaVersion: REGISTRY_VERSION, nextNumber: 1, accounts: []};
        const reg = parseObject(text);
        if (!reg || !Array.isArray(reg.accounts))
            throw new EngineError('io', _('registry.json is damaged; it is left untouched. Check it by hand.'));
        if (reg.schemaVersion !== REGISTRY_VERSION)
            throw new EngineError('io', fmt(_('registry.json has an unknown version (%s).'), reg.schemaVersion));
        return reg;
    }

    saveRegistry(reg) {
        this.ensure();
        writeJson(this.paths.registry, reg);
    }

    slotDir(uuid) {
        return this.paths.slotDir(uuid);
    }

    readSlotCredText(uuid) {
        return readText(`${this.slotDir(uuid)}/.credentials.json`);
    }

    readSlotCred(uuid) {
        return parseObject(this.readSlotCredText(uuid));
    }

    readSlotAccount(uuid) {
        const cfg = parseObject(readText(`${this.slotDir(uuid)}/.claude.json`));
        return cfg?.oauthAccount ?? null;
    }

    /** Slots never store machine-shared keys (mcpOAuth…). */
    writeSlotCred(uuid, cred) {
        ensureDir(this.slotDir(uuid));
        writeAtomic(`${this.slotDir(uuid)}/.credentials.json`, stringifyStrict(stripShared(cred)));
    }

    /** Keep whatever claude added to the slot's .claude.json; replace oauthAccount. */
    writeSlotAccount(uuid, account) {
        ensureDir(this.slotDir(uuid));
        const path = `${this.slotDir(uuid)}/.claude.json`;
        const cfg = parseObject(readText(path)) ?? {};
        cfg.oauthAccount = account;
        writeAtomic(path, stringifyStrict(cfg));
    }

    /**
     * Safety copy. Identical payloads are stored once (name carries a hash).
     * @returns {string} file name
     */
    stash(reason, payload) {
        this.ensure();
        const body = stringifyStrict({reason, savedAt: new Date(this.clock()).toISOString(), ...payload});
        const hash = sha256(JSON.stringify(payload)).slice(0, 12);
        const suffix = `-${reason}-${hash}.json`;
        const existing = listDir(this.paths.stashDir).find(n => n.endsWith(suffix));
        if (existing)
            return existing;
        const name = `${stamp(this.clock())}${suffix}`;
        writeAtomic(`${this.paths.stashDir}/${name}`, body);
        return name;
    }

    removeStash(name) {
        removeTree(`${this.paths.stashDir}/${name}`);
    }

    /** Move a whole account folder into stash/ (remove never deletes). */
    stashSlotDir(uuid) {
        this.ensure();
        const name = `removed-${uuid}-${stamp(this.clock())}`;
        move(this.slotDir(uuid), `${this.paths.stashDir}/${name}`);
        return name;
    }

    newTmpDir(prefix) {
        this.ensure();
        const dir = `${this.paths.tmpDir}/${prefix}${GLib.uuid_string_random().slice(0, 8)}`;
        ensureDir(dir);
        return dir;
    }

    slotExists(uuid) {
        return exists(`${this.slotDir(uuid)}/.credentials.json`);
    }
}

/** registry entry from an oauthAccount block. */
export function entryFromAccount(oauthAccount, number, nowMs) {
    return {
        number,
        uuid: oauthAccount.accountUuid,
        email: oauthAccount.emailAddress ?? '',
        orgUuid: oauthAccount.organizationUuid ?? '',
        orgName: oauthAccount.organizationName ?? '',
        alias: null,
        disabled: false,
        state: 'ok',
        addedAt: new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z'),
    };
}

/** Find by number, email or alias (CLI identifiers). */
export function resolveAccount(reg, ident) {
    const s = String(ident ?? '').trim();
    if (/^\d+$/.test(s))
        return reg.accounts.find(a => a.number === Number(s)) ?? null;
    return reg.accounts.find(a => a.alias === s) ??
        reg.accounts.find(a => a.email === s) ?? null;
}
