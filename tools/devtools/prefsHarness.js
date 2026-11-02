// Sandbox-only: run extension/prefs.js in a plain Adw window (the
// org.gnome.Shell.Extensions D-Bus service does not reach a headless shell).
//   gjs -m prefsHarness.js <extension-dir> <page-name>
//
// No top-level await: app.run() must run at module top level so GJS keeps
// draining the promise job queue (prefs.js is async).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw?version=1';
import GIRepository from 'gi://GIRepository';

// like /usr/share/gnome-shell/org.gnome.Shell.Extensions (needs Shew)
GIRepository.Repository.prepend_search_path('/usr/lib/gnome-shell/girepository-1.0');
GIRepository.Repository.prepend_library_path('/usr/lib/gnome-shell');
Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();

const [extDir, page = 'general'] = ARGV;
const metadata = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${extDir}/metadata.json`)[1]));
metadata.path = extDir;
metadata.dir = Gio.File.new_for_path(extDir);

let Prefs = null;
import(`file://${extDir}/prefs.js`).then(m => {
    Prefs = m.default;
}).catch(e => console.error(`[harness] ${e.message}`));

const app = new Adw.Application({application_id: 'io.github.oswaldocarabano.ClaudeAccountSwitcher.PrefsHarness', flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    app.hold();
    const open = () => {
        if (!Prefs)
            return GLib.SOURCE_CONTINUE;
        const win = new Adw.PreferencesWindow({application: app, title: 'Claude Account Switcher'});
        new Prefs(metadata).fillPreferencesWindow(win);
        win.visible_page_name = page;
        win.present();
        app.release();
        return GLib.SOURCE_REMOVE;
    };
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, open);
    GLib.timeout_add_seconds(0, 40, () => {
        app.quit();
        return GLib.SOURCE_REMOVE;
    });
});
app.run([]);
