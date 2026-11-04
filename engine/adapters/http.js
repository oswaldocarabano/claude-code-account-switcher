// Anthropic's private OAuth surface over libsoup 3, synchronous
// (the engine is a short-lived process of its own).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import {EngineError} from '../lib/errors.js';

export const OAUTH_BETA = 'oauth-2025-04-20';
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_API = 'https://api.anthropic.com';
const DEFAULT_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

export class HttpError extends Error {
    constructor(kind, status = 0, retryAfterS = null, body = null) {
        super(kind);
        this.kind = kind;
        this.status = status;
        this.retryAfterS = retryAfterS;
        this.body = body;
    }
}

/**
 * Endpoint overrides are honoured only with CLAUDE_ACCOUNTS_TESTING=1; otherwise their
 * presence is refused so a stray variable can never redirect real tokens.
 */
export function endpointsFromEnv(env = n => GLib.getenv(n)) {
    const testing = env('CLAUDE_ACCOUNTS_TESTING') === '1';
    const api = env('CLAUDE_ACCOUNTS_API_BASE');
    const token = env('CLAUDE_ACCOUNTS_TOKEN_URL');
    if ((api || token) && !testing)
        throw new EngineError('internal', 'CLAUDE_ACCOUNTS_API_BASE/CLAUDE_ACCOUNTS_TOKEN_URL are only accepted with CLAUDE_ACCOUNTS_TESTING=1.');
    return {
        apiBase: (testing && api) || DEFAULT_API,
        tokenUrl: (testing && token) || DEFAULT_TOKEN_URL,
        testing,
    };
}

export class Http {
    constructor({apiBase, tokenUrl, userAgent = 'claude-accounts/0.2.1', timeoutS = 5}) {
        this.apiBase = apiBase;
        this.tokenUrl = tokenUrl;
        this.userAgent = userAgent;
        this.session = new Soup.Session({timeout: timeoutS, idle_timeout: timeoutS});
        this.requests = 0;
    }

    _send(method, url, headers, body) {
        const msg = Soup.Message.new(method, url);
        if (!msg)
            throw new HttpError('bad-url');
        msg.get_request_headers().append('User-Agent', this.userAgent);
        for (const [k, v] of Object.entries(headers))
            msg.get_request_headers().append(k, v);
        if (body !== undefined) {
            msg.set_request_body_from_bytes('application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        }
        let bytes;
        this.requests++;
        try {
            bytes = this.session.send_and_read(msg, null);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
                throw new HttpError('timeout');
            throw new HttpError('network');
        }
        const status = msg.status_code;
        const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
        const ra = msg.get_response_headers().get_one('Retry-After');
        const retryAfterS = ra !== null && /^\s*\d+(\.\d+)?\s*$/.test(ra) ? Number(ra) : null;
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = undefined;
        }
        return {status, text, json, retryAfterS};
    }

    /** GET /api/oauth/usage → raw JSON (throws HttpError). */
    usage(accessToken) {
        const r = this._send('GET', `${this.apiBase}/api/oauth/usage`, {
            'Authorization': `Bearer ${accessToken}`,
            'anthropic-beta': OAUTH_BETA,
        });
        if (r.status === 200 && r.json && typeof r.json === 'object')
            return r.json;
        if (r.status === 200)
            throw new HttpError('bad-response', 200);
        throw new HttpError(`http-${r.status}`, r.status, r.retryAfterS);
    }

    /** GET /api/oauth/profile → {uuid, email, orgUuid} or null on any failure. */
    profile(accessToken) {
        try {
            const r = this._send('GET', `${this.apiBase}/api/oauth/profile`, {
                'Authorization': `Bearer ${accessToken}`,
                'anthropic-beta': OAUTH_BETA,
            });
            const uuid = r.status === 200 ? r.json?.account?.uuid : null;
            if (typeof uuid !== 'string' || !uuid.trim())
                return null;
            return {
                uuid: uuid.trim(),
                email: typeof r.json.account.email === 'string' ? r.json.account.email : null,
                orgUuid: typeof r.json.organization?.uuid === 'string' ? r.json.organization.uuid : null,
            };
        } catch {
            return null;
        }
    }

    /**
     * Refresh-token grant. Returns {ok: true, resp} or {ok: false, error}
     * where error is invalid_grant | invalid_client | transient.
     */
    refresh(refreshToken) {
        let r;
        try {
            r = this._send('POST', this.tokenUrl, {}, {
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: CLIENT_ID,
            });
        } catch {
            return {ok: false, error: 'transient'};
        }
        if (r.status === 200 && typeof r.json?.access_token === 'string' &&
            Number.isFinite(Number(r.json.expires_in)))
            return {ok: true, resp: r.json};
        if ([400, 401, 403].includes(r.status) &&
            (r.json?.error === 'invalid_grant' || r.json?.error === 'invalid_client'))
            return {ok: false, error: r.json.error};
        return {ok: false, error: 'transient'};
    }
}
