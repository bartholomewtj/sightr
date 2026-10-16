# Changelog

Sightr uses [Semantic Versioning](https://semver.org). `bun scripts/bump.ts patch|minor|major --note "..."`
moves the Unreleased notes into a new version entry and keeps the three version files in step; CI refuses
a build where they disagree.

## [Unreleased]

### Added
- The bridge keeps a v2 thread store, `threads.sqlite`, in the state directory. Nothing reads it yet; it is the base for the v2 app. Events older than seven days are pruned hourly (the newest 50,000 always stay). If the file cannot be read it is moved aside as `threads.sqlite.corrupt-<time>` and a new one starts. `SIGHTR_V2=0` turns it off.
- The v2 thread store now follows the herd: each Herdr workspace is a project and each pane (shells too) is a thread, with its status, title and unread-done mark. A pane that closes moves its thread to Archived after two polls; panes that closed while the bridge was down are archived at its next start. Unread stays in `activity.json`, so v1 and v2 agree on it.
- The Local tab lists the PC's loopback servers and opens them over the tailnet.
- Pull down at the top of a pane, or of Spaces, to refresh the herd in place. A small mark tracks the pull. The refresh is the same revalidation the app already uses. It does not reload the page, and it does not load older history.

### Fixed
- Sending a reply from the phone is one request (spec 24). The collie#34 guard used to run in the browser, so each step was a phone↔bridge round trip: check for the input box, clear a stranded draft, type, check the text arrived, submit, check the box cleared. That cost 1.5–2 s on mobile data, and up to 9 s with a draft to clear. The same guard now runs on the bridge (`POST /api/pane/:id/send`), reading Herdr directly every 100 ms: 0.2–0.6 s live on Claude, Grok, Cursor, Agy and Pi. A stranded draft is cleared using a count from a read taken milliseconds earlier (its length + 8), not the last poll's length + 32. An older bridge without the route gets the browser-side guard as before.
- Much less traffic with a pane open. Over 3–16 Oct, a phone with a pane open made about 3.2 pane reads and 2.4 journal reads a second, each one a fresh Herdr round-trip. Three changes cut that:
  - The bridge no longer pushes a snapshot after every Herdr poll when nothing but its timestamp changed (29 of 31 in a 45 s live sample). Each push made every client re-read its open pane and journal.
  - Identical Herdr pane reads already in flight are shared, by any number of phones and tabs. Nothing is cached once a read settles, and any write to the pane clears the shared reads, so a re-read after a keystroke always sees the key.
  - A Claude chat view refreshes when the pane's screen moves (at most every 1.5 s), not on every push.
  - Reading a pane you have already seen no longer pushes a snapshot. Every pane read re-stamped "seen", that changed the snapshot, the push made the phone re-read the pane, and the read re-stamped it: about two pushes a second for as long as a pane was open. A read pane now keeps its stamp for 30 s (ages show "just now" under a minute anyway). A read that clears an unread pane still pushes at once.
- Direct typing reaches the terminal at the speed you type. Each character went as its own key, paced 80 ms apart (about 12 characters a second at best). Typed batches are now marked `typed`, and the bridge writes each run of characters in one go. Named keys (Enter, Backspace, arrows, chords) stay paced one by one, and so do recipe and menu keys.
- The open pane's mirror refreshes every 0.4 s while you type (composer edits, replies and keys, and for 5 s after the last one), every 0.75 s while its agent is working or blocked, and every 1.5 s otherwise. A key press on an agent pane gets a confirming re-read 200 ms after the burst, as shell panes already did, because the immediate read often lands before the agent repaints. The Claude chat refreshes up to every 0.75 s while the screen moves.
- `sightr-ctl conn` no longer counts time in the background as an outage. The 15 s latch could fire just after the page hid. The gap it opened then stayed open until the next wake, so a phone in a pocket for an hour logged an hour-long red gap. Over 3–16 Oct that put the live share at 68%; the true figure was 97%. The phone opens no gap while hidden, and the analyser takes hidden time out of gaps already in the log. It also counts a re-sent batch once (688 duplicate lines in that window). A gap with a bridge start inside it, however long the bridge was gone, is now blamed on the restart. Requests in a usage window that spans a restart are listed apart, so a release no longer raises a 5xx finding.
- A snapshot stream that dies without an error no longer leaves a stale herd on screen as if it were live. While the stream is open, the home screen does not poll. A mobile network can drop the flow without either end hearing about it, and nothing then noticed until the app was hidden and shown again. If the bridge has written nothing for 35 s (it pings every 15 s), the app now drops the stream, polls at once and reconnects. These drops are logged as `stale`, and `sightr-ctl conn` counts them.
- Opening or leaving a pane no longer reconnects the snapshot stream (about 6,300 reconnects in 23 visible hours over 3–16 Oct). A stream that opens and dies at once now backs off instead of reconnecting every second; the backoff starts over only after a stream has stayed up 30 s. A late error from a stream already replaced can no longer close its successor. The stream reconnects as soon as the phone reports it is online again.
- The bridge comes back on its own after a blanket `taskkill /F /IM bun.exe /T`. That kill took both bun processes and left the PowerShell launcher alive, and Task Scheduler only retries a failed start, so the bridge stayed down until someone ran start. The launcher now relaunches the supervisor on any non-zero exit and logs a `[launcher]` line to `sightr-error.log`. A clean stop still stays down.
- Pi multi-question cards. The phone types a custom answer: arrows move to Type something, Enter opens the box, and Enter sends the text. No digit is sent.
- A pull-down at the top of the phone no longer reloads the PWA. The document is pinned to the screen, the same way desktop already was, and the pane scroller contains its own overscroll. A needs-you card stays on screen.
- A pane read that Herdr answers for a different pane is no longer served as this pane's screen. The phone showed one pane's title and chat while the reply went to another; the bridge stamped the requested pane id onto the body and dropped the id Herdr returned. The mirror, the history fingerprint and the prompt-binding re-read now refuse that body.

## [1.2.1] - 2026-10-03

### Fixed
- Live updates over the snapshot stream work with `SIGHTR_TRUSTED_USER` set. Every broadcast snapshot was the text "identity required", so the phone dropped the stream, reconnected about every 1.4 s and never received a push. Found by the new connection telemetry (#65).

## [1.2.0] - 2026-10-03

### Added
- Connection telemetry. The phone records request outcomes and latency, amber/red stretches, wake-to-live time and snapshot-stream lifetimes, and posts them to `POST /api/conn`. The bridge adds stream attach/detach, Herdr link drops and restarts. Everything goes to `<state-dir>/conn.log`, which holds timings only. `sightr-ctl conn [--since 7d] [--json]` analyses the log and lists findings with the setting to change. `SIGHTR_CONN_LOG=0` turns it off.

### Fixed
- A marked operator-decision card submits `whistlr reply` with `--thread`, `--text`, `--payload`, `--schema whistlr.decision_response.v1`, and `--json`. The reply is the broker's JSON answer, including its id. A non-JSON exit is a failure.
- Grok question cards. A two-option checkbox checks the tapped row. Radio options past 9 answer with a–f when the list runs from 1 with no gaps. The phone types the free-text row when its key is z.

## [1.1.1] - 2026-09-28

### Fixed
- The #52 cleanup: pending changelog notes survive a bump, error responses are no-store, and the control script and bridge agree on SIGHTR_SKIP_SERVE.
- Herdr actions work on a freshly linked checkout (#51). They ran `build/sightr-action-v1.exe`, which
  only a first `start` from PowerShell could build, so every action failed with "The system cannot
  find the path specified". Actions now run `contrib/windows/sightr-ctl.ps1` through `powershell`;
  the launcher and its C# source are gone.
- `scripts/bump.ts` keeps pending notes (#52). It replaced the whole `## [Unreleased]` section with its
  `--note`, so every pending note was lost. It now moves them under the new version heading, puts the
  note first in its section, and leaves an empty `## [Unreleased]` on top.
- The control script reads `SIGHTR_SKIP_SERVE` with the bridge's spellings (`1`, `on`, `true`, `yes`)
  and also from the plugin `.env` when it starts the bridge (#52). Before, only `1` counted, so the
  script and the bridge could disagree.
- Error responses (`jsonError`, `text()`) are `cache-control: no-store`, like every JSON 200 (#52).
- Settings → Bridge → Read lines says what it does: the read size when a request names none, and the
  least read before a prompt send. The phone's pane view asks for its own count (#52).

## [1.1.0] - 2026-09-28

The council spec run (#32–#49) and #47. One prompt-binding matcher for every harness; Cursor long sends and autocomplete refusal; Agy multi-line replies arrive as one message; the pane menu, composer and Settings reshape; SSE-driven polling; dialogs lifted for Claude, Cursor, Grok and Antigravity. Details below.

### Added
- Marked draftr operator-decision cards submit `whistlr reply --payload` and do not type into the pane.
- `push-list` and `push-forget` control-script verbs (metadata only; require an explicit match or `*`).
- `docs/ARCHITECTURE.md` and `docs/HARNESS_CONTRIBUTING.md` stubs so older ADR links resolve.

### Changed
- `web/src/lib/actions.ts` is split into one module per job (`menu-`, `wizard-`, `prompt-`, `preview-`,
  `multi-select-` and `reply-action.ts`), each with its tests beside it; `actions.ts` re-exports them.
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
- A multi-line reply to Antigravity arrives as one message (#47). It used to be able to submit the
  first line and queue the rest. The reply is typed as a bracketed paste, in pieces of at most 1000
  characters cut mid-word, so Agy neither folds it into a `[Pasted text]` token nor trims newlines
  at a seam. A draft taller than the box (`↑ N more lines`) is matched by its visible tail. The reply
  route takes `paste: true`.
- The prompt-binding matcher the bridge 409s on is now the one the tests check, for every harness's
  dialogs, and two Claude dialogs under a named session are pinned in the binding contract.
- A long reply to Cursor no longer stalls with "didn't reach the input box". Cursor collapses a long
  paste into `[Pasted text #N +M lines]` like Claude, and Sightr now accepts that token when it
  matches the send, so Enter goes out.
- A send while Cursor's autocomplete list is open is refused, with nothing typed. It used to clear the
  `/` draft with an unbound `ctrl+k` sweep into the popup. Close the list and send again.
- A reconnect or refused banner no longer stacks a second notch gap on top of the header. While a
  banner is open it pads the status bar and the headers below it don't.
- Closing Find returns to the live tail instead of leaving you parked at the last match. Find now
  freezes shell and TUI panes (draftr, browser) too, so a replacing screen no longer jumps the match.
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
