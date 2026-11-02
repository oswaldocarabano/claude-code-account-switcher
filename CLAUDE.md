# Claude Code Account Switcher for GNOME

Claude Code account switcher for GNOME Shell 46, **native and self-contained** (no Python, no third-party switcher). Two pieces, both GJS (ES modules):

- `engine/`: the `claude-accounts` **engine**, a command-line program run with `gjs -m`. It is the only thing that reads or writes credentials.
- `extension/`: the GNOME Shell **extension**. It draws the UI and runs the engine as a subprocess with `--json`.

## Project rules

- **Main requirement: switching accounts keeps the history and the conversations open in every tab and terminal.** Only the account credential (`claudeAiOauth` and account-scoped keys in `~/.claude/.credentials.json`) and the `oauthAccount` block of `~/.claude.json` are replaced. Nothing else under `~/.claude` is read or written. Never start user sessions with another `CLAUDE_CONFIG_DIR`.
- **Everything is in English**: code, identifiers, comments, commit messages and source strings. The UI is translated with gettext (domain `claude-account-switcher`) into Spanish, French, Simplified Chinese and Hindi (`po/`). New user-facing strings go through `_()`/`ngettext()` (extension and engine), then `python3 tools/xgettext.py` and update every `po/*.po`. Placeholders `%s`/`%d` are filled in order.
- **Credentials: only the engine touches them.** The extension (GNOME Shell process) never reads or writes Claude Code's files or the engine's data; it only watches the credentials file's mtime and calls the engine.
- **Never refresh the active account's token.** It belongs to Claude Code. Only saved copies of inactive accounts are refreshed (preferably through `claude auth status` in the account's own folder).
- **Claude Code's locks** (proper-lockfile directories): `<config>/.oauth_refresh.lock`, then `<config>.lock`, then `~/.claude.json.lock`. Wait up to 9 s for the credential locks and 15 s for the config lock. **No network requests while holding them.** Never write or delete `.oauth_refresh.lock.owner`.
- **Atomic writes:** `0600` temp file next to the target, then `rename`, writing through symlinks. In `~/.claude.json` only `oauthAccount` changes.
- **Never destroy a credential.** If it cannot be attributed to an account with certainty, it goes to `stash/` and into no account.
- **Never log tokens** (logs, notifications, errors, JSON). All engine output goes through `redact()`.
- **Do not trust `loggedIn`** from `claude auth status`: Claude Code wipes the tokens on `invalid_grant` and still answers `loggedIn: true`. Read the file.
- **Usage endpoint budget:** ≤ 20 requests/hour per account normally, hard cap 25/hour even with `--force`.
- **Nothing synchronous on GNOME Shell's main thread.** Async `Gio.Subprocess` with a `Gio.Cancellable` and a timeout. The engine is a separate short-lived process, so it may block.
- **`disable()` undoes everything `enable()` did.** Nothing is created in constructors or at module level.
- One engine command at a time from the extension (`busy` flag); switching has priority over refreshing.
- Every `--json` output carries `schemaVersion: 1`; the extension rejects any other version.

## Development

- `just test` (≈4 min, includes a 1,000-rotation race) / `just test-quick` / `just lint`.
- Tests run the engine in a temporary `HOME` under `/tmp` with a fake API and a fake `claude`. **Never test against the real `~/.claude`.**
- `just nested-sandbox` opens a nested GNOME Shell on a sandbox (fake HOME, fake accounts, own `dbus-run-session`, so your real dconf is untouched). `just screenshots`, `just prefs-shots`, `just cycle` and `just cycle-nested` automate screenshots and enable/disable cycles.
- After editing the `.gschema.xml` or `po/`: `just build`. Package with `just pack`.
