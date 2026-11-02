#!/bin/sh
# Sandbox for the extension. Everything runs with a FAKE HOME under
# /tmp/cas-sandbox* and inside its own `dbus-run-session`, so neither your
# ~/.claude nor your real dconf settings are touched.
#   sandbox.sh setup|nested|headless|screenshots|cycle|clean <root> [args]
set -eu
cmd=$1
root=$2
case "$root" in /tmp/cas-sandbox*) ;; *) echo "root must start with /tmp/cas-sandbox" >&2; exit 2 ;; esac
REPO=$(cd "$(dirname "$0")/.." && pwd)

shell_in_sandbox() { # $1 = nested|headless ; extra env must be exported by the caller
    mode=$1
    . "$root/env"
    unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME CLAUDE_CONFIG_DIR
    # mutter 46 opens the nested window through the host X display (Xwayland)
    # headless: no way to reach the host display from inside the sandbox
    [ "$mode" = headless ] && unset DISPLAY WAYLAND_DISPLAY
    export LANG=en_US.UTF-8 LANGUAGE="${CLAUDE_ACCOUNTS_LANG:-en}"
    export MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x900
    schemedir="$REPO/extension/schemas"
    # Flags differ between GNOME versions (e.g. X11/--wayland is gone in newer ones).
    help=$(gnome-shell --help 2>&1 || true)
    wayland=""; echo "$help" | grep -q -- '--wayland' && wayland="--wayland"
    flags="--nested $wayland"
    [ "$mode" = headless ] && flags="--headless $wayland --virtual-monitor 1600x900"
    shellmode=""; gnome-shell --list-modes 2>/dev/null | grep -qx ubuntu && shellmode="--mode=ubuntu"
    # CLAUDE_ACCOUNTS_IGNORE_VERSION=1: load the extension even if this GNOME
    # version is not declared yet (compatibility testing).
    noversion=""; [ "${CLAUDE_ACCOUNTS_IGNORE_VERSION:-0}" = 1 ] && noversion="gsettings set org.gnome.shell disable-extension-version-validation true"
    dbus-run-session -- sh -c "
        gsettings set org.gnome.shell disable-user-extensions false
        $noversion
        gsettings set org.gnome.shell enabled-extensions \"['claude-account-switcher@oswaldocarabano.github.io', 'cas-devtools@sandbox.test']\"
        gsettings set org.gnome.desktop.interface color-scheme '${CLAUDE_ACCOUNTS_SCHEME:-prefer-dark}'
        gsettings set org.gnome.desktop.interface gtk-theme '${CLAUDE_ACCOUNTS_GTK_THEME:-Yaru}'
        gsettings set org.gnome.desktop.notifications show-banners false
        gsettings --schemadir '$schemedir' set org.gnome.shell.extensions.claude-account-switcher claude-path ''
        exec gnome-shell $flags $shellmode
    "
}

case "$cmd" in
setup)
    shift 2
    gjs -m "$REPO/tools/sandbox.js" setup "$root" "$@"
    ;;
nested)
    shell_in_sandbox nested
    ;;
headless)
    shell_in_sandbox headless
    ;;
screenshots)
    out=$3
    mkdir -p "$out"
    export CLAUDE_ACCOUNTS_DEVTOOLS=screenshots CLAUDE_ACCOUNTS_DEVTOOLS_QUIT=1 CLAUDE_ACCOUNTS_SHOTS_DIR="$out" FAKE_LOGIN_HANG=1
    for n in ${CLAUDE_ACCOUNTS_SHOT_ACCOUNTS:-3 8 1}; do
        tag=""; [ "$n" != 3 ] && tag="-$n"
        gjs -m "$REPO/tools/sandbox.js" setup "$root" --accounts "$n" >/dev/null
        CLAUDE_ACCOUNTS_SHOT_TAG="$tag" timeout 180 "$0" "${CLAUDE_ACCOUNTS_SHELL_MODE:-nested}" "$root" > "$root/shell-screenshots$tag.log" 2>&1 || true
        grep -E 'CasDev|JS ERROR' "$root/shell-screenshots$tag.log" | tail -12
    done
    ;;
prefs)
    out=$3
    mkdir -p "$out"
    gjs -m "$REPO/tools/sandbox.js" setup "$root" >/dev/null
    export CLAUDE_ACCOUNTS_DEVTOOLS=prefs CLAUDE_ACCOUNTS_DEVTOOLS_QUIT=1 CLAUDE_ACCOUNTS_SHOTS_DIR="$out"
    timeout 120 "$0" headless "$root" > "$root/shell-prefs.log" 2>&1 || true
    grep -E 'CasDev|JS ERROR|Gjs-CRITICAL|prefs' "$root/shell-prefs.log" | tail -20
    ;;
cycle)
    mode=${3:-headless}   # headless | nested
    export CLAUDE_ACCOUNTS_DEVTOOLS=cycle CLAUDE_ACCOUNTS_DEVTOOLS_QUIT=1
    timeout 180 "$0" "$mode" "$root" > "$root/shell-cycle.log" 2>&1 || true
    grep -E 'CasDev' "$root/shell-cycle.log"
    echo "--- extension-related errors:"
    grep -iE 'JS ERROR|JS WARNING|CRITICAL|Error' "$root/shell-cycle.log" | grep -iE 'claude-account|ClaudeAccountSwitcher|extension' || echo "(none)"
    ;;
clean)
    gjs -m "$REPO/tools/sandbox.js" stop "$root" || true
    rm -rf "$root"
    ;;
*)
    echo "usage: sandbox.sh setup|nested|headless|screenshots|cycle|clean <root>" >&2
    exit 2
    ;;
esac
