# Changelog

Sightr uses [Semantic Versioning](https://semver.org). `bun scripts/bump.ts patch|minor|major --note "..."`
adds an entry here and keeps the three version files in step; CI refuses a build where they disagree.

## [1.0.1] - 2026-09-14

### Changed
- Merge Sighter 0.124.5–0.129.0: phone ask lifts (Cursor, Pi, Grok, Claude), dialog snapshot guard, split-pane pane naming, Cursor working-chrome fixes.

### Fixed
- Phone Spaces scrolls inside the screen so the bottom tab bar stays pinned at the foot of the
  viewport instead of floating mid-content when you reach the end of the tree.

## [1.0.0] - 2026-09-14

### Added
- First public release as Sightr. Bridge, phone PWA, Windows control script, Herdr plugin manifest,
  Claude/Pi/Grok/Antigravity/Cursor adapters, WebAuthn reconnect lock, audit trail, Web Push.

### Changed
- Removed the SSSF trace visualiser and its Traces tab; it is becoming a separate tool.
- Renamed from Sighter. Every identifier moved with it: the `herdr.sightr` plugin id, the `SIGHTR_*`
  environment variables, `sightr-ctl.ps1`, the state and config directories. On first start the bridge
  copies a pre-1.0 Sighter state directory into the new one if the new one is empty.

### Fixed
- `start` and `restart` keep an existing Task Scheduler registration when re-registering it is
  denied, so `restart` from a normal shell no longer leaves the bridge stopped.
- `start` and `restart` compile the Herdr action launcher when `build/` is missing, so a linked
  checkout's Herdr actions work without a separate `build`.
