// Fake Anthropic OAuth API for tests and the sandbox.
//
//   gjs -m tests/fakeApi.js --dir <state-dir> [--port N]
//
// Writes the port to <state-dir>/port once listening. Behaviour is controlled by
// <state-dir>/scenario.json, re-read on every request:
//   {"usage": "ok|429|429-noretry|401|slow|garbage|500",
//    "token": "ok|invalid_client|slow", "profile": "ok|down|other"}
// Like the real server, a refresh grant invalidates the refresh token it
// consumed. Every issued token is appended to <state-dir>/issued-tokens.txt so
// tests can prove none of them ever leaks into logs or output.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const args = ARGV;
const dir = args[args.indexOf('--dir') + 1];
const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 0;
GLib.mkdir_with_parents(dir, 0o700);

const state = {
    accounts: {}, // uuid -> {uuid, email, orgUuid, orgName, usage}
    access: {}, // token -> {uuid, expiresAt}
    refresh: {}, // token -> {uuid, valid}
    stats: {usage: {}, profile: 0, token: 0, tokenInvalid: 0},
};
let counter = 0;

function scenario() {
    try {
        const [, b] = GLib.file_get_contents(`${dir}/scenario.json`);
        return JSON.parse(new TextDecoder().decode(b));
    } catch {
        return {};
    }
}

function rand() {
    return GLib.uuid_string_random().replace(/-/g, '').slice(0, 20);
}

function logToken(t) {
    const f = `${dir}/issued-tokens.txt`;
    let prev = '';
    try {
        prev = new TextDecoder().decode(GLib.file_get_contents(f)[1]);
    } catch {}
    GLib.file_set_contents(f, `${prev}${t}\n`);
}

function issue(uuid, expiresInS = 28800) {
    counter++;
    const at = `sk-ant-oat01-FAKE${counter}x${rand()}`;
    const rt = `sk-ant-ort01-FAKE${counter}x${rand()}`;
    const expiresAt = Date.now() + expiresInS * 1000;
    state.access[at] = {uuid, expiresAt};
    state.refresh[rt] = {uuid, valid: true};
    logToken(at);
    logToken(rt);
    return {at, rt, expiresAt};
}

function defaultUsage() {
    const h = new Date(Date.now() + 3 * 3600e3).toISOString();
    const d = new Date(Date.now() + 4 * 86400e3).toISOString();
    return {five_hour: {utilization: 12, resets_at: h}, seven_day: {utilization: 30, resets_at: d}};
}

function usageBody(acct) {
    const u = acct.usage ?? defaultUsage();
    const win = w => (w ? {
        utilization: w.utilization, resets_at: w.resets_at, limit_dollars: null,
        used_dollars: null, remaining_dollars: null, locked_reason: w.locked_reason ?? null,
    } : null);
    return {
        five_hour: win(u.five_hour),
        seven_day: win(u.seven_day),
        seven_day_opus: null,
        seven_day_sonnet: null,
        extra_usage: u.extra_usage ?? {is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null},
        spend: u.spend ?? {used: {amount_minor: 0, currency: 'USD', exponent: 2}, limit: null, percent: 0, severity: 'normal', enabled: false},
        limits: u.limits ?? [],
        pace: null,
        amber_cistern: {some: 'internal'},
    };
}

function reply(msg, status, obj, headers = {}) {
    msg.set_status(status, null);
    for (const [k, v] of Object.entries(headers))
        msg.get_response_headers().append(k, v);
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    msg.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode(text));
}

function later(msg, ms, fn) {
    msg.pause();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        fn();
        msg.unpause();
        return GLib.SOURCE_REMOVE;
    });
}

function bearer(msg) {
    const h = msg.get_request_headers().get_one('Authorization') ?? '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function bodyJson(msg) {
    try {
        const b = msg.get_request_body().flatten().get_data();
        return JSON.parse(new TextDecoder().decode(b));
    } catch {
        return {};
    }
}

function authed(msg) {
    const a = state.access[bearer(msg)];
    if (!a || a.expiresAt <= Date.now())
        return null;
    return state.accounts[a.uuid] ?? null;
}

function handle(msg, path) {
    const sc = scenario();
    const method = msg.get_method();

    if (path === '/__admin/account' && method === 'POST') {
        const b = bodyJson(msg);
        state.accounts[b.uuid] = {...state.accounts[b.uuid], ...b};
        return reply(msg, 200, {ok: true});
    }
    if (path === '/__admin/issue' && method === 'POST') {
        const b = bodyJson(msg);
        const acct = state.accounts[b.uuid];
        if (!acct)
            return reply(msg, 404, {error: 'unknown account'});
        const t = issue(b.uuid, b.expiresIn ?? 28800);
        return reply(msg, 200, {
            accessToken: t.at, refreshToken: t.rt, expiresAt: t.expiresAt,
            refreshTokenExpiresAt: Date.now() + 28 * 86400e3, account: acct,
        });
    }
    if (path === '/__admin/state') {
        const valid = {};
        for (const [rt, v] of Object.entries(state.refresh)) {
            if (v.valid)
                (valid[v.uuid] ??= []).push(rt);
        }
        return reply(msg, 200, {validRefresh: valid, stats: state.stats});
    }

    if (path === '/api/oauth/usage') {
        const acct = authed(msg);
        const uuid = state.access[bearer(msg)]?.uuid ?? 'unknown';
        state.stats.usage[uuid] = (state.stats.usage[uuid] ?? 0) + 1;
        switch (sc.usage) {
        case '429':
            return reply(msg, 429, {error: 'rate_limited'}, {'Retry-After': '120'});
        case '429-noretry':
            return reply(msg, 429, {error: 'rate_limited'});
        case '500':
            return reply(msg, 500, {error: 'server'});
        case 'garbage':
            return reply(msg, 200, '<html>not json');
        case 'slow':
            return later(msg, 8000, () => reply(msg, 200, acct ? usageBody(acct) : {}));
        case '401':
            return reply(msg, 401, {error: 'unauthorized'});
        }
        if (!acct)
            return reply(msg, 401, {error: {type: 'authentication_error', message: 'token expired'}});
        return reply(msg, 200, usageBody(acct));
    }

    if (path === '/api/oauth/profile') {
        state.stats.profile++;
        if (sc.profile === 'down')
            return reply(msg, 503, {error: 'down'});
        const acct = authed(msg);
        if (!acct)
            return reply(msg, 401, {error: 'unauthorized'});
        const shown = sc.profile === 'other' ? {uuid: 'acct-alien-0000', email: 'alien@example.com'} : acct;
        return reply(msg, 200, {account: {uuid: shown.uuid, email: shown.email}, organization: {uuid: acct.orgUuid}});
    }

    if (path === '/v1/oauth/token' && method === 'POST') {
        state.stats.token++;
        if (sc.token === 'invalid_client')
            return reply(msg, 401, {error: 'invalid_client'});
        const b = bodyJson(msg);
        const r = state.refresh[b.refresh_token];
        if (!r || !r.valid) {
            state.stats.tokenInvalid++;
            return reply(msg, 400, {error: 'invalid_grant', error_description: 'refresh token invalid'});
        }
        r.valid = false;
        const t = issue(r.uuid);
        const acct = state.accounts[r.uuid];
        const body = {
            access_token: t.at, refresh_token: t.rt, expires_in: 28800, scope: 'user:inference user:profile',
            account: {uuid: acct.uuid, email_address: acct.email}, organization: {uuid: acct.orgUuid},
        };
        if (sc.token === 'slow')
            return later(msg, 3000, () => reply(msg, 200, body));
        return reply(msg, 200, body);
    }
    return reply(msg, 404, {error: 'not found'});
}

const server = new Soup.Server({});
server.add_handler(null, (_srv, msg, path) => {
    try {
        handle(msg, path);
    } catch (e) {
        reply(msg, 500, {error: String(e)});
    }
});
server.listen_local(port, Soup.ServerListenOptions.IPV4_ONLY);
// stdout may be block-buffered when piped: publish the port through a file.
GLib.file_set_contents(`${dir}/port`, String(server.get_uris()[0].get_port()));
new GLib.MainLoop(null, false).run();
