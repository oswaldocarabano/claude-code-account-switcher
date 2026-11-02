/* eslint-disable no-await-in-loop */ // sequential UI steps by design
// Development-only helper, installed ONLY in the sandbox HOME by tools/sandbox.sh.
// Driven by CLAUDE_ACCOUNTS_DEVTOOLS=screenshots|cycle. Takes screenshots of the extension's
// menu (dark and light) and cycles enable/disable to look for leaks.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'claude-account-switcher@oswaldocarabano.github.io';
let started = false; // the Shell may enable us twice during startup
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));
const log = m => console.log(`[CasDev] ${m}`);

function indicator() {
    return Main.panel.statusArea[UUID] ?? null;
}

async function waitFor(fn, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (fn())
            return true;
        await sleep(200);
    }
    return false;
}

function shot(path, x, y, w, h) {
    return new Promise((resolve, reject) => {
        const file = Gio.File.new_for_path(path);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        const s = new Shell.Screenshot();
        s.screenshot_area(Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), Math.round(w), Math.round(h), stream, (o, res) => {
            try {
                o.screenshot_area_finish(res);
                stream.close(null);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function menuShot(dir, name, delay = 900) {
    const ind = indicator();
    const actor = ind.menu.actor;
    await sleep(delay);
    const [mx, my] = actor.get_transformed_position();
    const [mw, mh] = actor.get_transformed_size();
    const [ix] = ind.get_transformed_position();
    const [iw] = ind.get_transformed_size();
    const x = Math.min(mx, ix) - 16;
    const right = Math.max(mx + mw, ix + iw) + 16;
    await shot(`${dir}/${name}.png`, x, 0, right - x, my + mh + 16);
    log(`shot ${name}`);
}

async function screenshots(dir) {
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    await waitFor(() => indicator()?._store?.data?.accounts?.length >= 0 && indicator()?._store?.data);
    Main.overview.hide();
    await sleep(1500);
    const ind = indicator();
    const tag = GLib.getenv('CLAUDE_ACCOUNTS_SHOT_TAG') ?? '';
    // top bar only
    const [ix] = ind.get_transformed_position();
    const [iw, ih] = ind.get_transformed_size();
    await shot(`${dir}/topbar${tag}.png`, ix - 220, 0, iw + 260, ih);
    for (const scheme of ['prefer-dark', 'prefer-light']) {
        iface.set_string('color-scheme', scheme);
        await sleep(1500);
        const suffix = scheme === 'prefer-dark' ? 'dark' : 'light';
        ind.menu.open(false);
        await menuShot(dir, `panel${tag}-${suffix}`);
        if (!tag)
            await shot(`${dir}/desktop-${suffix}.png`, 0, 0, global.stage.width, global.stage.height);
        if (!tag) {
            // hover first inactive card -> countdowns
            const cards = [...ind._cards.values()];
            const second = cards[1];
            if (second) {
                second.sync_hover?.();
                second.set_hover?.(true);
                await menuShot(dir, `panel-hover-${suffix}`);
                second.set_hover?.(false);
            }
        }
        ind.menu.close(false);
        await sleep(400);
    }
    if (!tag) {
        // login flow (fake claude hangs: FAKE_LOGIN_HANG=1)
        iface.set_string('color-scheme', 'prefer-dark');
        await sleep(800);
        ind._store.startLogin({activate: true});
        await waitFor(() => ind._store.login?.url, 8000);
        ind.menu.open(false);
        await menuShot(dir, 'login-dark');
        ind._store.cancelLogin();
        ind.menu.close(false);
        await sleep(800);
        // switching state (spinner + pulsing icon)
        const target = ind._store.data.accounts.find(a => !a.active && a.state === 'ok');
        ind.menu.open(false);
        ind._store.switchTo(target.number);
        await menuShot(dir, 'switching-dark', 120);
        await waitFor(() => !ind._store.busy, 20000);
        await sleep(600);
        await menuShot(dir, 'after-switch-dark');
        ind.menu.close(false);
    }
}

async function prefs(dir) {
    await waitFor(() => indicator()?._store?.data);
    Main.overview.hide();
    const repo = GLib.getenv('CLAUDE_ACCOUNTS_REPO');
    for (const page of (GLib.getenv('CLAUDE_ACCOUNTS_PREFS_PAGES') ?? 'general,topbar,accounts,about').split(',')) {
        const p = Gio.Subprocess.new(['gjs', '-m', `${repo}/tools/devtools/prefsHarness.js`, `${repo}/extension`, page],
            Gio.SubprocessFlags.NONE);
        const find = () => global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === 'Claude Account Switcher');
        await waitFor(() => find(), 30000);
        const win = find();
        await sleep(8000);
        const r = win?.get_frame_rect();
        if (r)
            await shot(`${dir}/prefs-${page}.png`, r.x, r.y, r.width, r.height);
        log(win ? `shot prefs-${page}` : `NO WINDOW for prefs-${page}`);
        p.force_exit();
        await sleep(800);
    }
}

async function cycle() {
    await waitFor(() => indicator()?._store?.data);
    for (let i = 0; i < 20; i++) {
        Main.extensionManager.disableExtension(UUID);
        await sleep(150);
        Main.extensionManager.enableExtension(UUID);
        await sleep(250);
        log(`cycle ${i + 1}`);
    }
    await sleep(3000);
    const indicators = Object.keys(Main.panel.statusArea).filter(k => k === UUID).length;
    const boxes = Main.panel._rightBox.get_children().length;
    log(`after cycles: indicators=${indicators} rightBoxChildren=${boxes}`);
    Main.extensionManager.disableExtension(UUID);
    await sleep(1000);
    log(`after disable: indicator=${indicator() ? 'present' : 'gone'}`);
}

export default class CasDevtools extends Extension {
    enable() {
        const mode = GLib.getenv('CLAUDE_ACCOUNTS_DEVTOOLS');
        if (!mode || started)
            return;
        started = true;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._timer = 0;
            const dir = GLib.getenv('CLAUDE_ACCOUNTS_SHOTS_DIR');
            const runs = {cycle: () => cycle(), prefs: () => prefs(dir), screenshots: () => screenshots(dir)};
            const run = (runs[mode] ?? runs.screenshots)();
            run.then(() => log('done')).catch(e => log(`FAILED ${e.message}\n${e.stack}`)).finally(() => {
                if (GLib.getenv('CLAUDE_ACCOUNTS_DEVTOOLS_QUIT') === '1')
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => global.context.terminate());
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }
}
