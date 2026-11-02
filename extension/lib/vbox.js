// Vertical St.BoxLayout across GNOME versions: `orientation` exists since
// GNOME 48 and `vertical` was removed in GNOME 51.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

const HAS_ORIENTATION = !!GObject.Object.find_property.call(St.BoxLayout, 'orientation');

/**
 * @param {object} [params] St.BoxLayout construct properties
 * @returns {St.BoxLayout}
 */
export function vbox(params = {}) {
    return new St.BoxLayout(HAS_ORIENTATION
        ? {...params, orientation: Clutter.Orientation.VERTICAL}
        : {...params, vertical: true});
}
