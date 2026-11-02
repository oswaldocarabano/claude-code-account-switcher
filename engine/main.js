// Entry point of the `claude-accounts` engine: `gjs -m engine/main.js <command> [options]`.
// With --json, stdout carries exactly one JSON object with schemaVersion 1
// (or, for `add --login`, one JSON event per line). Human text goes to stderr
// or to plain stdout without --json.

import System from 'system';
import {makeContext} from './usecases/context.js';
import {list, status} from './usecases/list.js';
import {switchAccount} from './usecases/switch.js';
import {addCurrent, addLogin, cancelLogins} from './usecases/add.js';
import {removeAccount, setAlias, setDisabled, doctor} from './usecases/manage.js';
import {EngineError, toEngineError, EXIT} from './lib/errors.js';
import {VERSION, SCHEMA_VERSION} from './lib/version.js';
import {redact} from '../shared/redact.js';
import {_, fmt} from './lib/i18n.js';

const USAGE = `claude-accounts ${VERSION} — Claude Code account switcher

Usage: claude-accounts <command> [options] [--json]
  list [--cached|--force]        accounts and usage
  status                         active account (no network)
  switch <n|email|alias>         switch account
  switch --best                  switch to the one with most quota left
  add --current                  save the current session
  add --login [--activate]       sign in with another account (browser)
  add --cancel                   cancel a sign-in in progress
  remove <n>                     remove (moved to stash/, never deleted)
  alias <n> <alias>|--unset      set or clear an alias
  disable|enable <n>             take out of / put back into --best
  doctor                         diagnostics
Options: --claude-path <path>, --refresh-strategy delegate|direct,
         --active-interval <s>, --version`;

export function parseArgs(argv) {
    const o = {positional: [], flags: new Set()};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (['--claude-path', '--refresh-strategy', '--active-interval'].includes(a))
            o[a.slice(2).replace(/-(\w)/g, (_m, c) => c.toUpperCase())] = argv[++i];
        else if (a.startsWith('--'))
            o.flags.add(a.slice(2));
        else
            o.positional.push(a);
    }
    o.command = o.positional.shift() ?? (o.flags.has('version') ? 'version' : 'help');
    return o;
}

function envelope(body, testing) {
    return {schemaVersion: SCHEMA_VERSION, ...testing ? {testing: true} : {}, ...body};
}

/** ASCII-only JSON (\uXXXX escapes) so the output never depends on the locale. */
export function asciiJson(obj) {
    return JSON.stringify(obj).replace(/[\u007f-\uffff]/g,
        c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function printJson(obj) {
    print(redact(asciiJson(obj)));
}

function human(command, r) {
    if (command === 'list') {
        for (const a of r.accounts) {
            const u = a.usage;
            const pct = w => (w ? `${Math.round(w.pct)}%${w.estimated ? '*' : ''}` : '–');
            print(`${a.active ? '●' : '○'} ${a.number}  ${a.alias ?? a.email}  5h ${pct(u?.fiveHour)}  7d ${pct(u?.sevenDay)}` +
                `${a.state !== 'ok' ? `  [${a.state}]` : ''}${a.usageError ? `  (${a.usageError})` : ''}`);
        }
        if (!r.accounts.length)
            print(_('No accounts yet. Use: claude-accounts add --current'));
    } else if (command === 'switch') {
        print(r.switched ? fmt(_('Active account: %s'), r.to.email) : fmt(_('Not switched (%s).'), r.reason));
    } else {
        print(JSON.stringify(r, null, 2));
    }
    for (const w of r.warnings ?? [])
        printerr(`${_('warning')}: ${w}`);
}

function run(argv) {
    const o = parseArgs(argv);
    const json = o.flags.has('json');
    if (o.command === 'help') {
        print(USAGE);
        return EXIT.OK;
    }
    if (o.command === 'version') {
        print(json ? JSON.stringify({schemaVersion: SCHEMA_VERSION, version: VERSION}) : VERSION);
        return EXIT.OK;
    }
    let ctx;
    try {
        ctx = makeContext({
            command: o.command,
            claudePath: o.claudePath,
            refreshStrategy: o.refreshStrategy,
            activeInterval: o.activeInterval ? Number(o.activeInterval) : undefined,
        });
        let result, exit = EXIT.OK;
        switch (o.command) {
        case 'list':
            result = list(ctx, {cached: o.flags.has('cached'), force: o.flags.has('force')});
            break;
        case 'status':
            result = status(ctx);
            break;
        case 'switch': {
            if (!o.flags.has('best') && !o.positional[0])
                throw new EngineError('invalid', _('Name the account: claude-accounts switch <n|email|alias> or --best'));
            ({result, exit} = switchAccount(ctx, {ident: o.positional[0], best: o.flags.has('best')}));
            break;
        }
        case 'add':
            if (o.flags.has('cancel')) {
                result = cancelLogins(ctx);
            } else if (o.flags.has('login')) {
                const emit = ev => (json ? printJson(envelope(ev, ctx.testing))
                    : ev.event === 'auth-url' && printerr(fmt(_('Open in your browser: %s'), ev.url)));
                result = addLogin(ctx, {activate: o.flags.has('activate'), emit});
                if (json) {
                    printJson(envelope({event: 'done', ...result}, ctx.testing));
                    return EXIT.OK;
                }
            } else {
                result = addCurrent(ctx);
            }
            break;
        case 'remove':
            result = removeAccount(ctx, o.positional[0]);
            break;
        case 'alias':
            result = setAlias(ctx, o.positional[0], o.flags.has('unset') ? null : o.positional[1] ?? null);
            break;
        case 'disable':
        case 'enable':
            result = setDisabled(ctx, o.positional[0], o.command === 'disable');
            break;
        case 'doctor':
            result = doctor(ctx);
            break;
        default:
            throw new EngineError('invalid', fmt(_('Unknown command: %s. Use: claude-accounts help'), o.command));
        }
        if (json)
            printJson(envelope(result, ctx.testing));
        else
            human(o.command, result);
        return exit;
    } catch (e) {
        const err = toEngineError(e);
        if (!(e instanceof EngineError))
            ctx?.log?.error(`${o.command} internal: ${e?.message}`);
        if (json) {
            const body = {error: err.toJSON()};
            if (o.command === 'add' && o.flags.has('login'))
                body.event = 'error';
            printJson(envelope(body, ctx?.testing));
        } else {
            printerr(`claude-accounts: ${err.message}`);
        }
        return err.exitCode;
    }
}

System.exit(run(ARGV));
