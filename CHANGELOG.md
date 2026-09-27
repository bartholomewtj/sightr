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
- The pane title opens the one pane menu: Find, Context, a Show terminal switch, Switch pane, Space
  overview, Rename, Close pane and Settings. Rename and Close work for a pane alone in its tab.
- The composer + menu is input only (Attach file, Keys, Agent commands, Type into terminal). Display
  prefs live in Settings; Show terminal is also in Settings → Display.
- Typing into the terminal has one Stop (the strip); + and Send are inert while it is armed.
- The gesture-wheel handle sits in the composer row instead of floating over cards and strips.
- Settings groups cards under This device and All devices. The wheel card shows the live wheel and
  is phone only. Bridge rows say whether a value is from `.env` or set here, with Use .env to reset;
  Notify delay is in seconds. `GET/POST /api/settings` add `overridden`, `defaults` and `reset`.
- Context shows the terminal for that visit only; Ctrl+` arms typing without rewriting the saved
  typing surface; a pane switch replaces history so Back returns where you started.
- The bottom nav stays on every Files screen; folders have a ⋯ for their actions; file actions are
  one compact row; a one-pane space shows that a tap opens it.

### Fixed
- "Thought for" is think time, not idle time. Thinking beside a reply or a tool shows a collapsed
  "Thought", and a finished last turn no longer pulses "Thinking". A gap to a user turn, or over 10
  minutes, is never labelled as thought.
- A Cursor tool on the last row of a finished pane no longer pulses "running" forever. Cursor never
  records tool output, so its tools now arrive marked complete (`unrecorded`) and show as a closed line.
- Swiping up through a pane's history can no longer show the recent turns twice. An unknown history
  cursor now returns nothing more, not the newest page, and the phone never prepends a turn it
  already holds. A refresh in flight no longer blocks loading older turns. The newest page is
  revalidated with an ETag, so an unchanged page costs a 304.
- Two Grok tabs in one folder no longer show each other's history. A quiet Grok pane guesses its log
  only when it is the only Grok pane there, or when exactly one log is unclaimed. Otherwise it waits
  for the screen, title or Herdr to say which. The bridge now reads the boxed `│ ❯ … │` prompt row
  with the same grammar as the phone (`shared/grok-prompt.ts`).
- A pre-1.0 Sighter `.env` now carries over. On start or bridge launch, when `herdr.sightr` has no
  `.env` and `herdr.sighter` (or `~/.config/sighter`) does, it is copied once with `SIGHTER_*` keys
  renamed to `SIGHTR_*`. Nothing is deleted or merged. `env-check` warns on any `SIGHTER_*` key,
  which is ignored.
- An open or installed Sightr picks up a rebuild within seconds. When the bridge names a build other
  than the page's, the app checks for a new service worker at once instead of waiting up to a minute.
  A stuck cache is cleared and reloaded at most once per build per tab.
- A Claude hook beacon no longer overrides the pane's real session. After `/clear`, `/resume` or a
  harness swap, history followed yesterday's hook file. Herdr's session id now wins, and a beacon for a
  different harness than the pane's applies nothing. An expired beacon still opens history when Herdr
  names no session.
- The harness conformance suite now fails any prompt-select that sends a digit its option row does
  not print (.adr/0009), not only generic menus. Antigravity's unnumbered trust card is the case it
  guards: it walks the pointer and presses Enter.
- On phone, tapping a blocked pane's output or the dialog panel's caption or padding no longer
  focuses the reply box, so the keyboard cannot cover the options. Dialog option rows are at least
  44px tall.
- Cursor and Antigravity panes waiting on a dialog showed done until opened; the bridge now reads their screen and reports needs you.
- Panes stay live: dump follows while Working, freeze only during Find, and the bridge keeps the
  fast Herdr cadence while any agent is working or blocked.
- Subscription-cap log names `push-forget`, the verb that exists.
- A second space on the same checkout (a subfolder of an open repo) was missing from the tree.
- Files search on a wide work root timed out and showed nothing; it now stops at a 6 s budget and
  the page says Searching, No matches, or that the search failed.
- Forcing Desktop mode On on a phone crushed the layout; below 768 px it is ignored with a note.
- Error toasts raised on Settings were never shown; "Tap Send again to type anyway" outlived its
  10 s arm; a stale error stays up until a later key press succeeds.
- The off state of a switch was invisible in dark mode.
- Claude 2.1.28x's unnumbered folder-trust dialog was not lifted, and the Yes/No strip offered in
  its place could not answer it; it now has option buttons, and Yes/No only shows when the agent's
  input box is on screen (#22).
- Claude `/context` output showed as a You bubble and left a Thinking timer counting on an idle
  pane; local commands are read from their system rows and `isMeta` rows are dropped (#23).
- A fresh Grok Build 1.0.41 pane refused the first message (untagged startup chip) (#24).
- With Raw terminal on, leftover input was not cleared before a send, so a palette command was
  appended to it (#25).
- A refused Yes/No word armed "Type anyway" for the next tap anywhere, and a stale send failure
  landing after a key press showed as a lasting error (#26).
- The wheel handle ignored a tap while a send was in flight (#27).
- The desktop sidebar cut space names to one or two letters.
- Antigravity's trust prompt sent invented digit keys; its options now walk the `>` pointer and
  press Enter (#21).

### Removed
- The composer Display dock and the + menu Terminal row (moved, see Changed), the unmounted
  Settings gear, the "Idle pause" copy for a feature that does not exist, and unused `setFontSize`,
  `shortLabel`, `toggleTab` and `setRecentDir`.
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
