// Error type of the engine. `kind` and the exit codes are part of the CLI contract.

import {redact} from '../../shared/redact.js';

export const EXIT = Object.freeze({OK: 0, ERROR: 1, NOTHING: 2, ACTION: 3});

const EXIT_BY_KIND = {
    'needs-login': EXIT.ACTION,
    'no-session': EXIT.ACTION,
    'wiped': EXIT.ACTION,
};

export class EngineError extends Error {
    /**
     * @param {string} kind
     * @param {string} message
     * @param {object} [extra] extra JSON fields (e.g. rolledBack)
     */
    constructor(kind, message, extra = {}) {
        super(redact(message, 300));
        this.name = 'EngineError';
        this.kind = kind;
        this.extra = extra;
    }

    get exitCode() {
        return EXIT_BY_KIND[this.kind] ?? EXIT.ERROR;
    }

    toJSON() {
        return {kind: this.kind, message: this.message, ...this.extra};
    }
}

/** Wrap anything thrown into an EngineError without leaking secrets. */
export function toEngineError(e) {
    if (e instanceof EngineError)
        return e;
    return new EngineError('internal', redact(e?.message ?? String(e), 300));
}
