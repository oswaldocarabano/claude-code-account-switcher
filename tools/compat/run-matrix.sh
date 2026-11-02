#!/bin/sh
# Test the extension and the engine on real GNOME Shell versions in Docker.
#   tools/compat/run-matrix.sh [fedora-release...]   (default: 39 40 41 42 43 44 45)
# Results go to /tmp/cas-compat/f<release>/ ; a summary is printed at the end.
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
releases=${*:-39 40 41 42 43 44 45}
base=/tmp/cas-compat
mkdir -p "$base"
for r in $releases; do
    out="$base/f$r"
    mkdir -p "$out"
    find "$out" -mindepth 1 -delete
    docker image inspect "cas-gnome:f$r" >/dev/null 2>&1 \
        || docker build -q --build-arg FEDORA="$r" -t "cas-gnome:f$r" "$REPO/tools/compat" >/dev/null \
        || { echo "f$r: image build failed"; continue; }
    docker run --rm -v "$REPO:/repo:ro" -v "$out:/out" "cas-gnome:f$r" sh /repo/tools/compat/check.sh
done
echo
printf '%-6s %-22s %-8s %-6s %-10s %-10s %s\n' fedora gnome-shell gjs tests cycles js-errors shots
for r in $releases; do
    out="$base/f$r"
    [ -f "$out/versions.txt" ] || { echo "f$r    (no result)"; continue; }
    shell=$(sed -n 's/^shell=GNOME Shell //p' "$out/versions.txt")
    gjsv=$(sed -n 's/^gjs=gjs //p' "$out/versions.txt")
    tests=$(grep -oE '[0-9]+ passed, [0-9]+ failed' "$out/tests.log" | tail -1 | sed 's/ passed, /\//; s/ failed//')
    cycles=$(grep -c '\] cycle [0-9]' "$out/shell-cycle.log" 2>/dev/null)
    # the indicator must really be in the panel after the cycles
    grep -q 'after cycles: indicators=1 ' "$out/shell-cycle.log" 2>/dev/null || cycles=0
    # JS errors from our code, plus extension load failures (logged as CRITICAL)
    errs=$(grep -E 'JS ERROR|Extension claude-account-switcher@[^:]*: ' "$out/shell-cycle.log" "$out/shell-screenshots.log" 2>/dev/null \
        | grep -ciE 'claude-account|ClaudeAccountSwitcher|cas-devtools|/repo/')
    shots=$(ls "$out/shots" 2>/dev/null | wc -l)
    printf '%-6s %-22s %-8s %-6s %-10s %-10s %s\n' "f$r" "$shell" "$gjsv" "${tests:--}" "${cycles:-0}/20" "$errs" "$shots"
done
