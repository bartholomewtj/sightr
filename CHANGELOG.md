# Changelog

Sightr uses [Semantic Versioning](https://semver.org). `bun scripts/bump.ts patch|minor|major --note "..."`
adds an entry here and keeps the three version files in step; CI refuses a build where they disagree.

## [Unreleased]

### Added
- Marked draftr operator-decision cards submit `whistlr reply --payload` and do not type into the pane.
- `push-list` and `push-forget` control-script verbs (metadata only; require an explicit match or `*`).
- `docs/ARCHITECTURE.md` and `docs/HARNESS_CONTRIBUTING.md` stubs so older ADR links resolve.

### Changed
- Slash-command catalogs live under `shared/catalog/`; `shared/agents.ts` is the harness table.
- Connection mark component is `sightr-mark` (`SightrLoader`), not dog-gallop.
- With EventSource open, the phone skips periodic `GET /api/snapshot` (home and open pane). Pane dump
  still polls; the journal newest page refreshes from SSE / status / visibility, not a 1.5s timer.
  SSE keepalive is a ping, not a full snapshot re-serialize.
- Archify HTML is generated in GitHub Pages CI from the JSON sources, not committed.
- `docs/HERDR_API.md` documents the Windows named pipe and `SIGHTR_POLL_*`.
- ADR index uses Sightr titles; 0007 is Superseded (idle-lock removed; reconnect lock is WebAuthn).

### Fixed
- Panes stay live: dump follows while Working, freeze only during Find, and the bridge keeps the
  fast Herdr cadence while any agent is working or blocked.
- Subscription-cap log names `push-forget`, the verb that exists.

### Removed
- Pre-refactor adapter-block golden (`golden.test.ts` / `golden.blocks.json`). Conformance plus
  per-adapter tests against the pane captures remain the gate.

## [1.0.5] - 2026-09-19

### Changed
- Prefetch 160 journal turns on pane open (was 80); swipe up still pages older ones.

### Fixed
- Refresh the session log while a pane is open, not only while Working, so chat catches up on every harness.

## [1.0.4] - 2026-09-18

### Fixed
- Hold Grok working→done blips so Ready · unseen does not flash between tool calls.

## [1.0.3] - 2026-09-18

### Fixed
- Grok composer verify: treat Shift+Enter/Alt+Enter:newline as hint chrome so a non-empty draft still locates the box.

## [1.0.2] - 2026-09-16

### Fixed
- Shell/TUI panes (draftr run tab): mirror updates after each key/button press without a manual PWA
  reload. Busts the pane ETag cache and retries reads across a short ladder so post-key fetches do
  not stick on a `304` of the pre-key frame; shell mirrors always follow the live tail.
- Shell pane reads: use Herdr `visible` (120-line cap) instead of `recent`/600-line scroll-harvest,
  so draftr run panes stay responsive on phone.
- Spaces tree: parent worktree connector glyph, softer family borders, two-line row alignment.
- Composer draft-clear: cap Backspace prefix sweep at 96 keys.

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
