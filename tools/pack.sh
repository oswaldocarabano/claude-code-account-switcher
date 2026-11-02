#!/bin/sh
# Build dist/<uuid>.shell-extension.zip with real copies of engine/ and shared/
# (they are symlinks in development) and the compiled translations.
set -eu
repo=$1
uuid=$2
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -rL "$repo/extension" "$stage/ext"
rm -f "$stage/ext/schemas/gschemas.compiled"
mkdir -p "$repo/dist"
cd "$stage/ext"
gnome-extensions pack . \
    --extra-source=lib --extra-source=engine --extra-source=shared \
    --extra-source=icons --extra-source=locale \
    --schema=schemas/org.gnome.shell.extensions.claude-account-switcher.gschema.xml \
    --out-dir="$repo/dist" --force
echo "dist/$uuid.shell-extension.zip"
