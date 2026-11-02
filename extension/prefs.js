// Preferences window: GTK4 + libadwaita, separate process.
// Never imports Shell UI modules. Account management goes through the engine.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Bound to the instance's gettext in fillPreferencesWindow().
let gettextFn = s => s;
const _ = s => gettextFn(s);

const REPO_URL = 'https://github.com/oswaldocarabano/claude-code-account-switcher';

function runEngine(path, settings, args) {
    return new Promise((resolve, reject) => {
        const gjs = GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs';
        const argv = [gjs, '-m', `${path}/engine/main.js`, ...args, '--json'];
        const claude = settings.get_string('claude-path');
        if (claude)
            argv.push('--claude-path', claude);
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, out] = p.communicate_utf8_finish(res);
                const obj = JSON.parse(out.trim().split('\n').at(-1));
                if (obj.schemaVersion !== 1)
                    throw new Error(_('The Claude Account Switcher engine is not compatible with this extension.'));
                if (obj.error)
                    throw new Error(obj.error.message);
                resolve(obj);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function claudeVersion(path) {
    return new Promise(resolve => {
        const bin = path || `${GLib.get_home_dir()}/.local/bin/claude`;
        const exe = GLib.file_test(bin, GLib.FileTest.IS_EXECUTABLE) ? bin : GLib.find_program_in_path('claude');
        if (!exe) {
            resolve(null);
            return;
        }
        try {
            const p = Gio.Subprocess.new([exe, '--version'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            p.communicate_utf8_async(null, null, (pp, res) => {
                try {
                    const [, out] = pp.communicate_utf8_finish(res);
                    resolve({exe, version: out.trim().split('\n')[0]});
                } catch {
                    resolve(null);
                }
            });
        } catch {
            resolve(null);
        }
    });
}

function spin(title, settings, key, lower, upper, step, subtitle = '') {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function combo(title, settings, key, items, subtitle = '') {
    const model = Gtk.StringList.new(items.map(([, label]) => label));
    const row = new Adw.ComboRow({title, subtitle, model});
    const sync = () => {
        row.selected = Math.max(0, items.findIndex(([v]) => v === settings.get_string(key)));
    };
    sync();
    row.connect('notify::selected', () => settings.set_string(key, items[row.selected][0]));
    settings.connect(`changed::${key}`, sync);
    return row;
}

export default class ClaudeAccountSwitcherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        gettextFn = this.gettext.bind(this);
        const settings = this.getSettings();
        window.set_default_size(640, 720);
        window.search_enabled = true;

        // ---------------- General
        const general = new Adw.PreferencesPage({name: 'general', title: _('General'), icon_name: 'preferences-system-symbolic'});
        const claude = new Adw.PreferencesGroup({
            title: _('Claude Code'),
            description: _('Claude Account Switcher uses the official claude command to add and renew accounts.'),
        });
        const pathRow = new Adw.EntryRow({title: _('Path to claude (empty = automatic)'), show_apply_button: true});
        pathRow.text = settings.get_string('claude-path');
        pathRow.connect('apply', () => settings.set_string('claude-path', pathRow.text.trim()));
        const detect = new Gtk.Button({label: _('Detect'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
        const status = new Adw.ActionRow({title: _('Status'), subtitle: '…'});
        const check = async () => {
            status.subtitle = _('Checking…');
            const r = await claudeVersion(settings.get_string('claude-path'));
            status.subtitle = r ? `✓ ${r.version} — ${r.exe}` : _('✗ claude not found');
        };
        detect.connect('clicked', check);
        pathRow.add_suffix(detect);
        claude.add(pathRow);
        claude.add(status);
        check();
        general.add(claude);

        const refresh = new Adw.PreferencesGroup({title: _('Refresh')});
        refresh.add(spin(_('Refresh interval'), settings, 'refresh-interval', 120, 3600, 30,
            _('Seconds. The usage endpoint allows few requests per hour; 180 s is a safe value.')));
        refresh.add(combo(_('How saved accounts renew their token'), settings, 'refresh-strategy', [
            ['delegate', _('Official CLI (recommended)')],
            ['direct', _('Token endpoint (no claude needed)')],
        ]));
        general.add(refresh);
        window.add(general);

        // ---------------- Appearance & notifications
        const look = new Adw.PreferencesPage({name: 'topbar', title: _('Top bar'), icon_name: 'preferences-desktop-appearance-symbolic'});
        const bar = new Adw.PreferencesGroup({title: _('Top bar')});
        bar.add(combo(_('Show'), settings, 'indicator-format', [
            ['name-and-usage', _('Name and usage')],
            ['usage', _('Usage only')],
            ['name', _('Name only')],
            ['icon', _('Icon only')],
        ]));
        const seven = new Adw.SwitchRow({title: _('7-day bar on the cards')});
        settings.bind('show-seven-day', seven, 'active', Gio.SettingsBindFlags.DEFAULT);
        bar.add(seven);
        look.add(bar);

        const alerts = new Adw.PreferencesGroup({title: _('Notifications and colours')});
        const notify = new Adw.SwitchRow({title: _('Notify every account switch')});
        settings.bind('notify-on-switch', notify, 'active', Gio.SettingsBindFlags.DEFAULT);
        alerts.add(notify);
        alerts.add(spin(_('Warn when 5-hour usage reaches'), settings, 'warn-threshold', 0, 100, 5, _('Percent. 0 = never.')));
        alerts.add(spin(_('Amber from'), settings, 'color-warn', 0, 100, 5, _('Percent')));
        alerts.add(spin(_('Red from'), settings, 'color-crit', 0, 100, 5, _('Percent')));
        const after = new Adw.SwitchRow({title: _('Use a newly added account right away')});
        settings.bind('activate-after-login', after, 'active', Gio.SettingsBindFlags.DEFAULT);
        alerts.add(after);
        look.add(alerts);
        window.add(look);

        // ---------------- Accounts
        const accountsPage = new Adw.PreferencesPage({name: 'accounts', title: _('Accounts'), icon_name: 'system-users-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: _('Saved accounts'),
            description: _('Removing an account moves its copy to the backups folder; nothing is deleted.'),
        });
        accountsPage.add(group);
        const rows = [];
        const toast = msg => window.add_toast(new Adw.Toast({title: msg}));
        const load = async () => {
            for (const r of rows.splice(0))
                group.remove(r);
            let data;
            try {
                data = await runEngine(this.path, settings, ['list', '--cached']);
            } catch (e) {
                const r = new Adw.ActionRow({title: _('Could not read the accounts'), subtitle: e.message});
                rows.push(r);
                group.add(r);
                return;
            }
            if (!data.accounts.length) {
                const r = new Adw.ActionRow({title: _('No accounts yet'), subtitle: _('Add one from the top bar menu.')});
                rows.push(r);
                group.add(r);
            }
            for (const a of data.accounts) {
                const exp = new Adw.ExpanderRow({
                    title: `${a.number}. ${a.email}`,
                    subtitle: [a.active ? _('active') : '', a.state === 'needs-login' ? _('needs to sign in') : '',
                        a.disabled ? _('out of rotation') : ''].filter(Boolean).join(' · '),
                });
                const alias = new Adw.EntryRow({title: _('Alias'), text: a.alias ?? '', show_apply_button: true});
                alias.connect('apply', async () => {
                    try {
                        await runEngine(this.path, settings, alias.text.trim()
                            ? ['alias', String(a.number), alias.text.trim()] : ['alias', String(a.number), '--unset']);
                        toast(_('Alias saved'));
                        load();
                    } catch (e) {
                        toast(e.message);
                    }
                });
                exp.add_row(alias);
                const rot = new Adw.SwitchRow({title: _('In rotation'), subtitle: _('Used by “switch to the one with most quota left”'), active: !a.disabled});
                rot.connect('notify::active', async () => {
                    try {
                        await runEngine(this.path, settings, [rot.active ? 'enable' : 'disable', String(a.number)]);
                    } catch (e) {
                        toast(e.message);
                    }
                });
                exp.add_row(rot);
                const remove = new Adw.ActionRow({title: _('Remove from Claude Account Switcher')});
                const btn = new Gtk.Button({label: _('Remove…'), valign: Gtk.Align.CENTER, css_classes: ['destructive-action'], sensitive: !a.active});
                if (a.active)
                    remove.subtitle = _('Switch to another account first.');
                btn.connect('clicked', () => {
                    const dlg = new Adw.MessageDialog({
                        transient_for: window,
                        heading: _('Remove account?'),
                        body: _('%s will no longer appear in Claude Account Switcher. Its saved copy is moved to the backups folder, not deleted.').replace('%s', a.email),
                    });
                    dlg.add_response('cancel', _('Cancel'));
                    dlg.add_response('remove', _('Remove'));
                    dlg.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
                    dlg.connect('response', async (_d, resp) => {
                        if (resp !== 'remove')
                            return;
                        try {
                            await runEngine(this.path, settings, ['remove', String(a.number)]);
                            toast(_('Account removed'));
                            load();
                        } catch (e) {
                            toast(e.message);
                        }
                    });
                    dlg.present();
                });
                remove.add_suffix(btn);
                exp.add_row(remove);
                rows.push(exp);
                group.add(exp);
            }
        };
        load().catch(e => console.error(`[ClaudeAccountSwitcher prefs] ${e.message}\n${e.stack}`));
        window.add(accountsPage);

        // ---------------- About
        const about = new Adw.PreferencesPage({name: 'about', title: _('About'), icon_name: 'help-about-symbolic'});
        const info = new Adw.PreferencesGroup({title: 'Claude Account Switcher', description: _('Claude Code account switcher for the GNOME top bar. Your conversations stay open when you switch.')});
        info.add(new Adw.ActionRow({title: _('Version'), subtitle: this.metadata['version-name'] ?? '0.1.0'}));
        const link = new Adw.ActionRow({title: _('Repository'), subtitle: REPO_URL, activatable: true});
        link.connect('activated', () => Gio.AppInfo.launch_default_for_uri(REPO_URL, null));
        info.add(link);
        about.add(info);
        const credits = new Adw.PreferencesGroup({
            title: _('Credits'),
            description: _('Built on what claude-swap (Onur Cetinkol), CCSwitcher (XueshiQiao) and Claude Bar (Thanh Ngô) learned. All MIT licensed.'),
        });
        about.add(credits);
        window.add(about);
    }
}
