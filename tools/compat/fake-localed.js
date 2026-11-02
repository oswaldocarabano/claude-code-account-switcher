// Container-only stand-in for systemd-localed on the private system bus.
// GNOME Shell 45/47's libgnome-desktop crashes when org.freedesktop.locale1
// is missing (it is always present on a real desktop).
//   gjs -m fake-localed.js   (with DBUS_SYSTEM_BUS_ADDRESS set)
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const XML = `<node>
  <interface name="org.freedesktop.locale1">
    <property name="Locale" type="as" access="read"/>
    <property name="VConsoleKeymap" type="s" access="read"/>
    <property name="VConsoleKeymapToggle" type="s" access="read"/>
    <property name="X11Layout" type="s" access="read"/>
    <property name="X11Model" type="s" access="read"/>
    <property name="X11Variant" type="s" access="read"/>
    <property name="X11Options" type="s" access="read"/>
  </interface>
</node>`;

const impl = {
    Locale: ['LANG=C.UTF-8'],
    VConsoleKeymap: 'us',
    VConsoleKeymapToggle: '',
    X11Layout: 'us',
    X11Model: 'pc105',
    X11Variant: '',
    X11Options: '',
};

const exported = Gio.DBusExportedObject.wrapJSObject(XML, impl);
Gio.bus_own_name(Gio.BusType.SYSTEM, 'org.freedesktop.locale1', Gio.BusNameOwnerFlags.NONE,
    conn => exported.export(conn, '/org/freedesktop/locale1'), null, null);
new GLib.MainLoop(null, false).run();
