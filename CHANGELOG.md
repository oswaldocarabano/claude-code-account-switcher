# Changelog

## 0.2.1 — 2026-11-04

- Usage no longer gets stuck when the active account's token has expired (Claude Code renews it only when it is used). The engine sends no request with an expired token, so it no longer piles up 401/403 errors or uses up the hourly budget. The card says "Usage will update when you use Claude Code", and usage is read as soon as Claude Code renews the token.

## 0.2.0 — 2026-11-01

- Supports GNOME Shell 45, 46, 47, 48, 49, 50 and 51 (was 46 only). Every version is tested in a container: engine tests, 20 enable/disable cycles and screenshots (`just compat`).
- Follows the GNOME 47+ system accent colour.
- Own spinner and icons instead of Shell internals and glyphs that some fonts lack.
- The installer refuses GNOME Shell 44 and older with a clear message.

## 0.1.0 — 2026-11-01

First release.

- GNOME Shell 46 top-bar extension: one card per Claude Code account with 5-hour and 7-day usage bars, reset times, per-model limits and extra usage.
- One-click account switching that keeps every open conversation; only the account credential and `oauthAccount` change.
- "Switch to the one with most quota left".
- Add accounts with the official browser sign-in, without touching the current session; renew logins before they expire.
- Notifications on switch and when a usage threshold is crossed.
- Preferences window (libadwaita) with an accounts page.
- `claude-accounts` command-line engine with `--json` output.
- Interface in English, Spanish, French, Simplified Chinese and Hindi.
- Self-contained: needs only GNOME (GJS, libsoup 3) and Claude Code.
