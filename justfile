# Claude Code Account Switcher — development tasks. Nothing here touches your real ~/.claude;
# `install`/`install-cli` only install the extension and the command.

uuid := "claude-account-switcher@oswaldocarabano.github.io"
repo := justfile_directory()
sandbox := "/tmp/cas-sandbox"

default:
    @just --list

# All tests (includes the 1,000-rotation race, ~3 min)
test:
    @{{repo}}/tools/kill-fakes.sh
    gjs -m {{repo}}/tests/run.js
    @{{repo}}/tools/kill-fakes.sh

# Quick tests (skips the slow ones)
test-quick:
    @{{repo}}/tools/kill-fakes.sh
    gjs -m {{repo}}/tests/run.js --quick
    @{{repo}}/tools/kill-fakes.sh

# Lint with GNOME Shell's configuration
lint:
    cd {{repo}} && npx --no-install eslint engine extension/lib extension/extension.js extension/prefs.js shared tests tools/devtools tools/sandbox.js

# Compile the schema and translations into extension/
build:
    glib-compile-schemas {{repo}}/extension/schemas/
    python3 {{repo}}/tools/msgfmt.py {{repo}}/po {{repo}}/extension/locale claude-account-switcher

# Install the extension (symlink) into YOUR session. Needs a log out on Wayland.
install: build
    mkdir -p ~/.local/share/gnome-shell/extensions
    ln -sfn {{repo}}/extension ~/.local/share/gnome-shell/extensions/{{uuid}}
    @echo "Installed. Log out and back in, then: gnome-extensions enable {{uuid}}"

# Install the `claude-accounts` command into ~/.local/bin
install-cli:
    mkdir -p ~/.local/bin
    printf '#!/bin/sh\nexec gjs -m %s/engine/main.js "$@"\n' "{{repo}}" > ~/.local/bin/claude-accounts
    chmod +x ~/.local/bin/claude-accounts

# Create the sandbox (fake HOME, 3 fake accounts, fake API) in {{sandbox}}
sandbox:
    {{repo}}/tools/sandbox.sh setup {{sandbox}}

# Nested session on the sandbox (a window with another GNOME Shell)
nested-sandbox: build sandbox
    {{repo}}/tools/sandbox.sh nested {{sandbox}}

# Screenshots in assets/screenshots/ from a nested Shell (1, 3 and 8 accounts; CLAUDE_ACCOUNTS_SHELL_MODE=headless for no window)
screenshots: build sandbox
    {{repo}}/tools/sandbox.sh screenshots {{sandbox}} {{repo}}/assets/screenshots
    python3 {{repo}}/tools/strip-png-metadata.py {{repo}}/assets/screenshots/*.png

# Headless: screenshots of the preferences pages into assets/screenshots/
prefs-shots: build
    {{repo}}/tools/sandbox.sh prefs {{sandbox}} {{repo}}/assets/screenshots
    python3 {{repo}}/tools/strip-png-metadata.py {{repo}}/assets/screenshots/*.png

# Enable/disable 20 times in a headless shell and check for errors
cycle: build sandbox
    {{repo}}/tools/sandbox.sh cycle {{sandbox}}

# Same 20 cycles inside a nested (windowed) GNOME Shell
cycle-nested: build sandbox
    {{repo}}/tools/sandbox.sh cycle {{sandbox}} nested

# Stop the sandbox's fake API and delete it
sandbox-clean:
    {{repo}}/tools/sandbox.sh clean {{sandbox}}

# Engine log of the sandbox
logs:
    tail -f {{sandbox}}/home/.local/state/claude-accounts/claude-accounts.log

# Zip package for gnome-extensions install
pack: build
    mkdir -p {{repo}}/dist
    {{repo}}/tools/pack.sh {{repo}} {{uuid}}

# Test on GNOME Shell 45–51 in Docker (Fedora 39–45); results in /tmp/cas-compat
compat *releases:
    {{repo}}/tools/compat/run-matrix.sh {{releases}}
