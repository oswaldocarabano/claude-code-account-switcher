# Contributing

Thanks for helping! Code, comments, commits and source strings are in English; the UI is translated with gettext (`po/`). Read [CLAUDE.md](CLAUDE.md) for the project rules: they apply to humans too.

## Tests

```bash
npm install          # eslint only
just test            # full suite (~4 min); just test-quick skips the long race test
just lint
```

Tests run in a temporary `HOME` with a fake API and a fake `claude`. They never touch your real `~/.claude`.

## Testing on every GNOME Shell version

The extension supports GNOME Shell 45 to 51 from a single codebase. `just compat` checks all of them with Docker; `just compat 39 45` checks only some (the arguments are Fedora releases):

| Fedora | 39 | 40 | 41 | 42 | 43 | 44 | 45 |
|---|---|---|---|---|---|---|---|
| GNOME Shell | 45 | 46 | 47 | 48 | 49 | 50 | 51 |

For each release it builds an image from `tools/compat/Dockerfile` (cached as `cas-gnome:f<release>`) and runs `tools/compat/check.sh` inside it, as an unprivileged user and with the repository mounted read-only:

1. the engine test suite (`tests/run.js --quick`);
2. a **headless GNOME Shell** with the extension in a sandbox: 20 enable/disable cycles (`tools/sandbox.sh cycle`);
3. screenshots of the menu with three example accounts.

Results go to `/tmp/cas-compat/f<release>/` (`shots/`, `shell-cycle.log`, `tests.log`, `versions.txt`) and a summary is printed:

```
fedora gnome-shell  gjs     tests  cycles  js-errors  shots
f39    45.10        1.78.5  71/0   20/20   0          10
...
```

A version **passes** when tests have 0 failures, cycles are 20/20 with the indicator really in the panel, `js-errors` is 0 (it also counts extension load failures) and the screenshots look right; open a few in `shots/`, a layout bug does not show up as an error. Only then add the version to `shell-version` in `extension/metadata.json`.

The container has no systemd, so `check.sh` provides what a desktop always has: a private D-Bus daemon as the system bus, `/tmp/.X11-unix`, and `tools/compat/fake-localed.js` (GNOME 45 and 47 crash without `org.freedesktop.locale1`). Undeclared versions are loaded with `disable-extension-version-validation` (`CLAUDE_ACCOUNTS_IGNORE_VERSION=1`). Logs mention GDM, logind, PolicyKit or GeoClue: that noise is expected.

To support a new GNOME release: add its Fedora release to the default list in `tools/compat/run-matrix.sh`, run `just compat <release>`, fix what breaks (feature-detect instead of comparing versions when possible) and update `metadata.json`, the README table and badge, and the version range in `install.sh`.

## Screenshots

`CLAUDE_ACCOUNTS_SHELL_MODE=headless just screenshots` and `just prefs-shots` regenerate `assets/screenshots/` from a sandbox with example accounts (no window; without the variable a nested window opens). The sandbox uses UTC so the clock does not reveal a time zone, and PNG metadata is stripped. Check every image before committing: no real names, emails or paths.

## Releasing

1. Bump the version in `extension/metadata.json` (`version-name`), `engine/lib/version.js`, the user agent in `engine/adapters/http.js`, the fallback in `extension/prefs.js` and `tests/engine/e2e.test.js`; add a `CHANGELOG.md` entry.
2. `just test`, `just lint`, `just compat`, regenerate screenshots if the UI changed.
3. Commit with UTC dates and the noreply email, so no time zone or personal address is published:
   ```bash
   now=$(date -u +%Y-%m-%dT%H:%M:%S+0000)
   GIT_AUTHOR_DATE=$now GIT_COMMITTER_DATE=$now git commit
   ```
4. `just pack`, then create the release with the zip, `install.sh` and `SHA256SUMS`:
   ```bash
   cd dist && cp ../install.sh . && sha256sum *.zip install.sh > SHA256SUMS
   gh release create vX.Y.Z *.zip install.sh SHA256SUMS --title "..." --notes-file notes.md
   ```
   The one-line installer downloads from `releases/latest`, so users get the new version as soon as it is published.
