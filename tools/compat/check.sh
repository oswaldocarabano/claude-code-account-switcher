#!/bin/sh
# Runs INSIDE a tools/compat container (fake HOME, headless GNOME Shell).
# Writes versions.txt, tests.log, cycle.txt, shell-cycle.log and shots/ to /out.
set -u
out=/out
mkdir -p "$out"
export HOME=/tmp/home XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p "$HOME"
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
mkdir -p -m 1777 /tmp/.X11-unix 2>/dev/null || true   # Xwayland sockets (GNOME <= 48)
# A private stand-in for the system bus (no systemd in the container).
dbus-daemon --session --address=unix:path=/tmp/system_bus_socket --fork --nopidfile >/dev/null 2>&1
export DBUS_SYSTEM_BUS_ADDRESS=unix:path=/tmp/system_bus_socket
# localed: GNOME 45/47 crash without it
gjs -m /repo/tools/compat/fake-localed.js >/dev/null 2>&1 &
sleep 1
cd /repo
{
    echo "shell=$(gnome-shell --version)"
    echo "gjs=$(gjs --version)"
    echo "glib=$(gjs -c 'const G = imports.gi.GLib; print(`${G.MAJOR_VERSION}.${G.MINOR_VERSION}`)')"
} > "$out/versions.txt"

gjs -m tests/run.js --quick > "$out/tests.log" 2>&1
echo "tests_exit=$?" >> "$out/versions.txt"

export CLAUDE_ACCOUNTS_IGNORE_VERSION=1 CLAUDE_ACCOUNTS_GTK_THEME=Adwaita
gjs -m tools/sandbox.js setup /tmp/cas-sandbox > /dev/null 2>&1
sh tools/sandbox.sh cycle /tmp/cas-sandbox headless > "$out/cycle.txt" 2>&1
cp /tmp/cas-sandbox/shell-cycle.log "$out/" 2>/dev/null
CLAUDE_ACCOUNTS_SHOT_ACCOUNTS=3 CLAUDE_ACCOUNTS_SHELL_MODE=headless \
    sh tools/sandbox.sh screenshots /tmp/cas-sandbox "$out/shots" > "$out/shots.txt" 2>&1
cp /tmp/cas-sandbox/shell-screenshots.log "$out/" 2>/dev/null
exit 0
