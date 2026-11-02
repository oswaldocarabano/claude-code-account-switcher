// gettext for the engine (same "claude-account-switcher" domain as the extension). The
// catalogs live in <extension>/locale: next to engine/ once packed, or in
// extension/locale inside the repository.

import GLib from 'gi://GLib';
import Gettext from 'gettext';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]); // engine/lib
const engineDir = GLib.path_get_dirname(here);
for (const dir of [`${engineDir}/../locale`, `${engineDir}/../extension/locale`]) {
    if (GLib.file_test(dir, GLib.FileTest.IS_DIR)) {
        Gettext.bindtextdomain('claude-account-switcher', GLib.canonicalize_filename(dir, null));
        break;
    }
}
const domain = Gettext.domain('claude-account-switcher');

export const _ = s => domain.gettext(s);
export const ngettext = (s, p, n) => domain.ngettext(s, p, n);

/** printf-lite: %s and %d in order. */
export function fmt(template, ...args) {
    let i = 0;
    return template.replace(/%[ds]/g, () => String(args[i++]));
}
