#!/bin/sh
# Claude Code Account Switcher for GNOME — installer.
#
#   curl -fsSL https://github.com/oswaldocarabano/claude-code-account-switcher/releases/latest/download/install.sh | sh
#   sh install.sh [--cli] [--zip <file>] [--source] [--uninstall]
#     --source  build the package from this checkout (no download, no `just` needed)
#
# Installs the GNOME Shell extension for the current user only (no sudo):
#   ~/.local/share/gnome-shell/extensions/claude-account-switcher@oswaldocarabano.github.io
# --cli also installs the `claude-accounts` command in ~/.local/bin.
set -eu

REPO="oswaldocarabano/claude-code-account-switcher"
UUID="claude-account-switcher@oswaldocarabano.github.io"
ASSET="$UUID.shell-extension.zip"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
CLI=0
ZIP=""
UNINSTALL=0
SOURCE=0

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
    --cli) CLI=1 ;;
    --zip) shift; ZIP=${1:-} ;;
    --uninstall) UNINSTALL=1 ;;
    --source) SOURCE=1 ;;
    -h|--help) printf 'Usage: sh install.sh [--cli] [--zip <file>] [--source] [--uninstall]\n'; exit 0 ;;
    *) die "unknown option: $1" ;;
    esac
    shift
done

if [ "$UNINSTALL" = 1 ]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    gnome-extensions uninstall "$UUID" 2>/dev/null || rm -rf "$EXT_DIR"
    [ -f "$HOME/.local/bin/claude-accounts" ] && grep -q "$UUID" "$HOME/.local/bin/claude-accounts" && rm -f "$HOME/.local/bin/claude-accounts"
    say "Uninstalled. Your saved accounts stay in ~/.local/share/claude-accounts (delete it yourself if you want)."
    exit 0
fi

# --- requirements
command -v gnome-extensions >/dev/null 2>&1 || die "gnome-extensions not found: this needs GNOME Shell."
command -v gjs >/dev/null 2>&1 || die "gjs not found. Install it with: sudo apt install gjs"
shell_version=$(gnome-shell --version 2>/dev/null | sed -n 's/.* \([0-9][0-9]*\)\..*/\1/p')
if [ -z "${shell_version:-}" ]; then
    warn "could not detect the GNOME Shell version; this extension needs GNOME Shell 45 to 51."
elif [ "$shell_version" -lt 45 ]; then
    die "GNOME Shell $shell_version is too old: this extension needs GNOME Shell 45 or newer."
elif [ "$shell_version" -gt 51 ]; then
    warn "tested on GNOME Shell 45 to 51; you have $shell_version. It may not load until a new release declares it."
fi
gjs -c "imports.gi.versions.Soup = '3.0'; imports.gi.Soup" >/dev/null 2>&1 \
    || die "libsoup 3 GI bindings missing. Install them with: sudo apt install gir1.2-soup-3.0"
if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
    warn "Claude Code (claude) not found. It is needed to add and renew accounts."
fi

# --- get the package
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ "$SOURCE" = 1 ]; then
    here=$(cd "$(dirname "$0")" && pwd)
    [ -f "$here/extension/metadata.json" ] || die "--source must be run from a clone of the repository"
    command -v python3 >/dev/null 2>&1 || die "python3 is needed to compile the translations"
    say "Building from source…"
    python3 "$here/tools/msgfmt.py" "$here/po" "$here/extension/locale" claude-account-switcher >/dev/null
    sh "$here/tools/pack.sh" "$here" "$UUID" >/dev/null
    ZIP="$here/dist/$ASSET"
elif [ -z "$ZIP" ]; then
    ZIP="$tmp/$ASSET"
    say "Downloading the latest release…"
    if command -v gh >/dev/null 2>&1 && gh release download --repo "$REPO" --pattern "$ASSET" --dir "$tmp" >/dev/null 2>&1; then
        :
    elif command -v curl >/dev/null 2>&1; then
        curl -fsSL "https://github.com/$REPO/releases/latest/download/$ASSET" -o "$ZIP" \
            || die "download failed (if the repository is private, log in with: gh auth login)"
    else
        die "need curl or gh to download the release"
    fi
fi
[ -f "$ZIP" ] || die "package not found: $ZIP"

# --- install
say "Installing the extension…"
gnome-extensions install --force "$ZIP"

if [ "$CLI" = 1 ]; then
    mkdir -p "$HOME/.local/bin"
    printf '#!/bin/sh\n# claude-accounts CLI (%s)\nexec gjs -m "%s/engine/main.js" "$@"\n' "$UUID" "$EXT_DIR" > "$HOME/.local/bin/claude-accounts"
    chmod +x "$HOME/.local/bin/claude-accounts"
    say "Installed the claude-accounts command in ~/.local/bin."
fi

if gnome-extensions enable "$UUID" 2>/dev/null; then
    say "Done. Claude Account Switcher is enabled."
else
    say "Done."
fi
cat <<EOF

Next steps:
  • On Wayland, log out and back in so GNOME Shell loads the extension.
  • Then, if needed: gnome-extensions enable $UUID
  • Open the menu in the top bar and click "Save" to add the account Claude Code is signed in with.
EOF
