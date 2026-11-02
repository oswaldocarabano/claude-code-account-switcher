# Changelog

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
