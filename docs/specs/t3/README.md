# T3-shape series — Sightr v2 (draft, 16 Oct 2026)

Draft. Nothing here is approved or built. It is the plan for making Sightr work the way
[T3 Code](https://github.com/pingdotgg/t3code) works (MIT, studied at `e3b35d1b`, 16 Oct 2026), but for a
herdr herd instead of agents T3 spawns itself. Sightr v2 replaced `Projects\tools\herdr-acp` (retired and deleted 17 Oct 2026), which
put herdr agents inside T3 as one ACP "model" picker.

One spec = one run. Do not implement a sibling spec in the same run. The rules at the end of
`../README.md` apply to every slice here too.

## What we take from T3, and what we don't

| T3 Code | Sightr v2 | Notes |
|---|---|---|
| One server owns every agent process | The bridge **observes** herdr panes and **spawns** new ones (`agent.start`) | Both: any pane in herdr is a thread; "New thread" makes a pane |
| Project = repo root (`workspaceRoot`) | Project = **herdr workspace** | Worktree workspaces keep their primary-checkout grouping |
| Thread = app conversation, outlives provider sessions | Thread = **herdr pane**; harness sessions inside it are dividers | A closed pane's thread moves to **Archived** (read-only) |
| Run (user turn) → attempt → execution nodes | Run = user message → agent `working` → back to `idle`/`done` | Boundaries come from herdr status, not a provider callback |
| `ProviderAdapterV2` (SDK/RPC/ACP gives structured events) | **Harness adapter** = journal tail + dialog sniff + guarded send | The pieces exist: `bridge/journal/*`, `harness/dialog-sniff.ts`, `guarded-send.ts` |
| Event-sourced: command → events + projection + outbox in one SQLite tx | Same, in **`bun:sqlite`** at `<state>/threads.sqlite` | No Effect. Plain TS, pure `decide()`, one transaction |
| `subscribeShell` + `subscribeThread {afterSequence}`, bounded replay (128) then snapshot | Same semantics over **SSE** (`Last-Event-ID`) + `POST` commands | See Transport below |
| `runtime_request` (approval / user input) answered with a decision | Dialog sniff + `prompt-binding` → `runtime-request`; answered by bound keys | The phone buttons Sightr already draws |
| Approvals replace the composer | Same | Spec T12 |
| Queue / steer follow-ups (server-persisted queue) | Same; the bridge drains the queue when the pane goes idle | Steer = interrupt key, wait idle, send |
| Sidebar shelves: pinned / active / snoozed / settled, status dots, unread-done | Same | Bridge-side, shared across devices (like ADR 0003 "seen") |
| Model / effort / permission mode pickers | At spawn: CLI args. Live: only where the harness has a key/slash for it | Capability flags per harness, never `if agent === …` in UI |
| Right panel: diff / files / terminal / preview / PR | Right panel: **Terminal** (the live mirror), **Files**, **Git status** | Phone: each is a sheet |
| Server-hosted PTYs (`terminal.*`) | Not needed: the pane *is* the terminal | The mirror reads it as today |
| Diff panel, per-run changed files, checkpoints | **Diffs series T24–T31** (read-only), see below | Reversed 18 Oct 2026 |
| Worktrees, rollback, commit/push/PR | **Out of scope** | herdr owns worktrees; Sightr never writes git state |
| Pairing / T3 Connect / Electron / Expo app | **Out**: one PWA over Tailscale, WebAuthn lock as today | Desktop and phone get equal weight via an adaptive layout |

## Domain (shared/v2/contracts.ts, spec T01)

- **Project** `{ id: workspace_id, label, labelSource: herd|user, number, repoKey?, worktreeOf?, order, status (roll-up), closedAt? }`.
- **Thread** `{ id (bridge uuid), paneId, terminalId, projectId, title, titleSource, harness, status, shelf: active|pinned|snoozed|settled|archived, snoozedUntil?, pinnedAt?, pinOrder?, settledAt?, unreadDone, lastActivityAt, createdAt, updatedAt, archivedAt?, archiveReason?, sessionRef?, capabilities, permissionMode?, model? }`. Shelf and time fields use T3's `OrchestrationV2AppThread` names.
  - Identity: a thread is bound to `(paneId, terminalId)`. A new `terminal_id` on the same `pane_id` is a new thread. Herdr pane ids are long and not reused, but the terminal id is the guard.
  - A harness session change inside the pane (relaunch, `/clear`, `/new`) is a `session` divider item, not a new thread.
- **Thread status** (worst-first, also the project roll-up): `approval` · `input` · `failed` · `working` · `done` (unread) · `idle` · `starting` (T07, while a spawn is in flight). From herdr `agent_status` plus `dialogDetected` plus the open runtime request's kind.
- **Run** `{ id, threadId, ordinal, userItemId?, status: running|completed|interrupted|failed, startedAt, completedAt? }` (T3's `completedAt`).
- **Turn item** mirrors T3's `OrchestrationV2TurnItem` (upstream `e3b35d1b`) so T3 UI components can be adapted. Base `{ id (stable: journal uuid + part index), threadId, runId: string|null, ordinal, status (T3 `TurnItemStatus`: idle|pending|running|waiting|completed|failed|cancelled|interrupted), title, startedAt, completedAt, createdAt, updatedAt, truncated? }`; `type` ∈ `user_message {messageId, text, attachments, inputIntent?}` · `assistant_message {messageId, text, streaming}` · `reasoning {text, streaming}` · `command_execution {input, output?, exitCode?, outputIndicatesFailure?}` · `file_change {fileName, additions?, deletions?, diffStr?, oldStr?, newStr?}` · `file_search {pattern?, results?}` · `web_search {patterns?, results?}` · `dynamic_tool {toolName, input, output?}` · `approval_request {requestId, requestKind, prompt?, options?}` · `user_input_request {requestId, questions}` · `system_notice {message}` · `error {failure, retry?}`, plus two Sightr extensions: `session {from, to}` (harness session divider) and `screen {text, capturedAt}` (a captured screen tail for harnesses with no journal). Tool status is the base `status`. Times are epoch ms, not T3's ISO strings.
- **Runtime request** `{ id, threadId, kind: permission|question|menu|trust|password, prompt, options[{label, keys, destructive?}], status: pending|resolved|expired, bindingHash }`.
- **Queued message** `{ id, threadId, text, attachments[], position, mode: queue|steer }`.
- **Event** `{ sequence (global, monotonic), threadId?, commandId?, type, payload, ts }`.

## Commands (spec T05)

`POST /api/v2/command` with `{ commandId, type, … }`. The `commandId` makes it idempotent
(a receipt row). Commands for one thread run one at a time on the existing pane write queue
(`bridge/pane-queue.ts`). The reply is `{ sequence }`: the intent committed, not that the work finished.

`thread.create` · `thread.rename` · `thread.pin {pinOrder?}|unpin` · `thread.snooze {until}|unsnooze` · `thread.settle|unsettle` ·
`thread.archive|unarchive` · `thread.markRead|markUnread` · `message.dispatch {text, attachments, mode: start|queue|steer}` ·
`queued.reorder|edit|cancel` · `run.interrupt` · `runtime-request.respond {requestId, optionIndex}` ·
`thread.permissionMode.set` · `thread.model.set` · `project.create` · `project.rename`.

## Ingest (specs T02–T04)

Three ingestors write events; none of them is driven by the client:

1. **Herd ingestor** (T02): the existing `StateEngine` snapshot loop and `events.subscribe` poker. It diffs each snapshot against the projection and emits `project.*` and `thread.*` events (created, status, title, cwd, closed → archived).
2. **Journal ingestor** (T03): per thread with a journal, tail the harness log with the existing `bridge/journal` adapters and emit `turn-item.updated` and run boundaries. It runs only while a client watches the thread or the thread is `working`, plus one catch-up pass when either starts. Byte offsets are kept in the store, so a bridge restart resumes where it was.
3. **Request ingestor** (T04): on status `blocked` or `dialogDetected`, read the visible screen, run the harness's dialog parser and `shared/prompt-binding.ts`, and emit `runtime-request.updated`. When the dialog leaves the screen, emit `resolved` (or `expired` if nobody answered from Sightr).

Shell panes (no agent) are threads too, with harness `shell`. Harnesses with no journal (Agy today; Codex, which `shared/agents.ts` does not list yet) still get threads, status, runtime requests, queue and steer. Their timeline holds the user messages Sightr sent plus a `screen` item captured when each run ends. The Terminal tab is their main view. T16 adds a Codex journal.

## Transport (decided in this plan; spec T05)

Keep **SSE + HTTP**, not a WebSocket.

- `GET /api/v2/shell` (SSE): a `snapshot` (projects, threads, runtime-request summaries), then events. `Last-Event-ID` resumes.
- `GET /api/v2/thread/:id` (SSE, `?after=<seq>` or `Last-Event-ID`): bounded replay of at most 128 events, else a fresh `snapshot {sequence, items (last N runs), historyCursor}`; then live events; `synchronized` after the catch-up.
- `GET /api/v2/thread/:id/history?before=<cursor>`: older runs, paged.
- Commands are plain `POST`s.

Why not a WebSocket like T3:
- SSE already survives `tailscale serve` and the iOS PWA lifecycle, and spec 77's watchdog applies to it.
- Commands are rare (a send, a tap), so a socket's two-way channel buys little.
- Sequence numbers and `Last-Event-ID` give the same resume semantics T3 gets from `afterSequence`.
- `/sightr-conn` keeps one transport family, so its baseline stays comparable.

This replaces the whole-snapshot push and the per-pane `GET /api/pane/:id` polling for v2 clients. The live terminal mirror still reads the pane, but only while the Terminal tab is open.

## Front end (specs T09–T15)

- **Where:** `web2/` beside `web/`. The bridge serves it at `/v2/` until cutover (T15). The v1 app stays at `/`, so Sightr is usable every day.
- **Stack: T3's web stack, so T3 components port with small edits.** Vite, React 19, **TanStack Router** (file routes), Tailwind 4, **Base UI** (`@base-ui/react`) wrapped in `components/ui/*` as T3 does, **Zustand** for UI stores, `@legendapp/list` for the virtualized timeline (T3's choice), `vite-plugin-pwa`. Not taken: Effect and `@effect/atom-react` (server state is our own event-applying store), Tiptap (the composer stays a plain text area, so phone dictation keeps working), Clerk, Electron and Expo.
- **Adapting T3 components as T3 releases (Bart, 16 Oct 2026).** web2 is built so T3's UI can keep flowing in:
  - **Same shapes.** `shared/v2/contracts.ts` mirrors T3's `OrchestrationV2TurnItem` and thread fields (T01). A T3 component that renders a turn item takes our item unchanged.
  - **Same layout and names.** web2's tree mirrors `apps/web/src` where it has the same job: `components/Sidebar.tsx`, `Sidebar.logic.ts`, `components/chat/MessagesTimeline.tsx` + `.logic.ts`, `chat/WorkLog.tsx`, `chat/ChatComposer.tsx`, `ComposerPendingApprovalPanel.tsx`, `QueuedRunsControl.tsx`, `RightPanelTabs.tsx`, `CommandPalette.tsx`, `keybindings.ts`. Pure `.logic.ts` files are the first to adopt verbatim.
  - **Same semantic tokens.** web2 defines the shadcn/T3 Tailwind token names (`background`, `foreground`, `muted-foreground`, `border`, `primary`, …) mapped to the locked ClaudeOS colours in `style/tokens.md`. T3 class names then render in Sightr's look.
  - **Seams, not forks.** T3 imports we don't have (Effect atoms, client-runtime, router hooks) go through small shims in `web2/src/t3/shims/*`, never by editing the adopted body more than needed.
  - **Provenance.** `web2/t3-upstream.json` lists every adopted or adapted file: `{ local, upstream, commit, mode: "verbatim" | "adapted" | "pattern" }`. Adapted files carry a one-line header naming the upstream path and commit, plus T3's MIT notice in `web2/THIRD_PARTY.md`.
  - **Upstream check.** `bun scripts/t3-upstream.ts [--ref <tag|sha>]` clones or updates T3 into a cache outside the repo. For each manifest row it prints whether upstream changed since the recorded commit, with the upstream diff. It also lists new T3 component files under the mirrored folders. Report only; porting stays a deliberate change that bumps the row's `commit`.
  - **Keeping up.** The weekly check, `/t3-sync` triage, sync slices and porting rules are in [`docs/T3_ADAPTATION.md`](../../T3_ADAPTATION.md). New T3 work reaches Sightr as `Tnn-sync-<sha7>` slices in this folder.
- **Reuse:** the harness parsers under `web/src/lib/harness/` (import them; they are leaf files), the markdown and tool-row renderers where they fit, `conn-telemetry`, the keys pad, the attach upload and the lock screen.
- **Layout (adaptive, like T3's iPad mode):**
  - ≥ 1024 px: sidebar | chat | right panel (Terminal / Files / Git), with `mod+k` palette and `when`-clause keybindings.
  - < 1024 px: sidebar is the home screen; thread is a full screen; right-panel tabs open as sheets.

## Slices

Order matters: T01→T05 make the bridge serve v2 with no UI; T09 can start once T05 lands.

| # | File | Area | One line |
|---|---|---|---|
| T01 | [T01-event-store.md](T01-event-store.md) | bridge | `shared/v2/contracts.ts` + `bun:sqlite` event store, projections, receipts, migrations |
| T02 | [T02-herd-ingest.md](T02-herd-ingest.md) | bridge | Workspaces → projects, panes → threads, status roll-up, close → archived |
| T03 | [T03-journal-ingest.md](T03-journal-ingest.md) | bridge | Journal tails → turn items + runs, stable ids, saved offsets, `screen` items |
| T04 | [T04-runtime-requests.md](T04-runtime-requests.md) | bridge | Dialog sniff + prompt binding → runtime requests; respond by bound keys |
| T05 | [T05-v2-api.md](T05-v2-api.md) | bridge | `POST /api/v2/command`, SSE shell + thread streams, bounded replay, history paging |
| T06 | [T06-dispatch-queue-steer.md](T06-dispatch-queue-steer.md) | bridge | `message.dispatch` start/queue/steer, queue drain on idle, `run.interrupt` |
| T07 | [T07-spawn.md](T07-spawn.md) | bridge | `thread.create`: new tab/split + `agent.start {kind, args}`; launch table per harness |
| T08 | [T08-live-modes.md](T08-live-modes.md) | bridge + shared | Capability flags; live permission-mode / model switch where the harness allows |
| T09 | [T09-web2-shell.md](T09-web2-shell.md) | web2 | Scaffold, adaptive layout, stream client with cursor + reconnect, served at `/v2/` |
| T10 | [T10-sidebar.md](T10-sidebar.md) | web2 | Projects, threads, status dots, shelves, archived list, undo toasts |
| T11 | [T11-timeline.md](T11-timeline.md) | web2 | Virtualized turn items, work-log grouping, thinking, session dividers, run banner |
| T12 | [T12-composer.md](T12-composer.md) | web2 | Send / stop / queue / steer, queued list, attachments, slash catalog; approvals replace the composer |
| T13 | [T13-right-panel.md](T13-right-panel.md) | web2 | Terminal (live mirror + direct typing), Files, Git status; palette + keybindings |
| T14 | [T14-new-thread.md](T14-new-thread.md) | web2 | New-thread draft: project, harness, model, mode; spawn progress |
| T15 | [T15-cutover.md](T15-cutover.md) | both | Parity checklist, `/` → v2, v1 at `/v1/` for one release, SW migration, build id per UI, retire herdr-acp |
| T16 | [T16-codex-journal.md](T16-codex-journal.md) | bridge | Codex rollout JSONL adapter, so Codex threads get a timeline |
| T17 | [T17-dialog-parity.md](T17-dialog-parity.md) | bridge + web2 | Multi-select, wizard and preview-select as runtime requests; bridge-side closed-loop recipes |
| T18 | [T18-settings-push-lock.md](T18-settings-push-lock.md) | web2 | Settings route: theme, display, push, lock devices, bridge settings, connection info |
| T19 | [T19-parity-ports.md](T19-parity-ports.md) | web2 | Gesture wheel, find (timeline and mirror), statusline, whistlr decision cards |
| T20 | [T20-upstream-sync.md](T20-upstream-sync.md) | scripts | Upstream check covers the contracts, answers in JSON, remembers skip/defer decisions |
| T24 | [T24-changed-files-card.md](T24-changed-files-card.md) | web2 | Changed-files card per run, from the run's `file_change` items |
| T25 | [T25-diff-renderer-spike.md](T25-diff-renderer-spike.md) | scripts + web2 | Measured spike: `@pierre/diffs` vs hand-rolled + highlighter vs status quo; `DiffCodeView` seam |
| T26 | [T26-bridge-diff-api.md](T26-bridge-diff-api.md) | bridge + shared | Working-tree and branch-vs-base review API: file list, lazy patches, whitespace, whole-file contents |
| T27 | [T27-diff-panel.md](T27-diff-panel.md) | web2 | Diff panel: scope and base pickers, changed-files tree, lazy patches |
| T28 | [T28-split-whitespace-context.md](T28-split-whitespace-context.md) | web2 | Split view (wide only), ignore whitespace, expand unchanged lines |
| T29 | [T29-line-comments.md](T29-line-comments.md) | web2 | Line comments become quoted text in the composer |
| T30 | [T30-git-checkpoints.md](T30-git-checkpoints.md) | bridge + shared | Snapshots in a private store at run start and end; exact per-run diffs, patches kept in SQLite |
| T31 | [T31-checkpoint-ui.md](T31-checkpoint-ui.md) | web2 | Card and panel run scope read checkpoints, fall back to the journal |

## React Compiler spike (T23, 18 Oct 2026): not adopted

T3 now builds `apps/web` with the React Compiler (`react({ compiler: true })`) and strips manual
memoisation file by file. web2 measured `babel-plugin-react-compiler` 1.0.0 through
`@rolldown/plugin-babel` (Babel 7; Babel 8 mis-lowers destructuring defaults) at T3 `16918b5`:

| Measure | Without | With |
|---|---|---|
| `web2/src/components/**` (150 files) | | 330 functions compile; 21 bail out in 19 files |
| Bail-outs that matter | | `MessagesTimelineBody` and `useTimelineFollow` (refs read in render), `QueuedRunsControl` (`try` without `catch`), `ChatHeader`, the Terminal, Files and Git panels. `ChatComposer` and `Sidebar` compile clean |
| 200 streamed text updates into `MessagesTimeline` (jsdom, DevTools-hook fiber count) | 601 commits, 3801 component renders | 601 commits, 3601 (−5%: only `MessageAuthorHeading` stops re-rendering; history rows already skip) |
| Profiler time for those updates (dev build, 3 runs) | 318–335 ms | 393–429 ms |
| JS bundle | 1,546 KB raw / 506 KB gzip | 1,700 KB / 569 KB (+10% / +12%) |
| web2 tests | 809 pass | 808 pass; `NewThreadView` "split is off… on for an open thread" fails (a value read outside React state is memoised) |

The timeline does not compile clean, renders barely drop, the bundle grows and one behaviour changes,
so web2 stays uncompiled. Compiler-only rewrites upstream are `skip` rows in `web2/t3-upstream.json`.
`SIGHTR_COMPILER=1` in `web2/vite.config.ts` turns it on for a re-measure (install the dev deps
unsaved; the command is in the config). Revisit if adapted ports start costing more than the bail-outs
would take to fix.

## Diff renderer spike (T25, 2026-10-18): B, hand-rolled renderer with highlight.js

**Decision: B**, the hand-rolled renderer on `parsePatch` with highlight.js 11.12.0 (`adapters/hand.tsx`). The spec's rule
asks first whether A passes every row. `@pierre/diffs` 1.5.2 fails four on its own numbers: a 471.6 KB lazy chunk (limit
150), +2,284 KB of `dist` (limit 400; still +481 KB with its grammars out of the precache), a 3.3 s cold open (limit 1.0)
and first render at 58 / 1,194 ms (limits 50 / 300). Its worker alone is 296.3 KB gzip, about twice the lazy-chunk
limit. B passes every decidable row on the reading the spec defines, so
the rule adopts B; the rank step is not reached. C fails split/expand/annotations, highlighting and the touch target.
`@pierre/diffs` stays untaken (so `docs/T3_ADAPTATION.md` is unchanged), and T3's Pierre-bound `StyledDiffCodeView.tsx`
and `lib/diffRendering.ts` are `skip` rows in `web2/t3-upstream.json`. The `diffs-adapter` default stays `status` until
T27, which flips it under the constraints below.

**How reading (b) counts.** The spec's rows say "first paint of the first file, large patch" and allow "files rendered
on open" for the node count, so the state they measure is the 40-file patch with its first file open: reading (a). The
fixture keeps the 3,000-line, 400-character file closed in that state (8th of 40), so (a) also checks that a closed
heavy file costs nothing (A's 616,965 nodes once it opens show why). Reading (b), that file open, is a stress case the
builder added, not a spec row, so it does not decide. It is still a state T27 reaches (a tap, or a reveal), so its two B
misses become gates on T27 rather than being waived: mounted nodes 6,872 (limit 5,000) and heap after unmount 20.6%
(limit 20%). Checked the other way: if (b) did decide, A and B both fail, and the rule gives C with split, expand and
annotations built into `hand.tsx` without a highlighter. Both B misses come from the highlighter (about 57 nodes per
400-character row over the 120 rows the first two windows mount at once, and the whole file's highlight map held while
open), so that outcome is B without highlighting: it would drop highlighting for 93% of changed files to fix two misses
that bounded windows fix. The heap miss is 0.06 MB over the line (2.1 MB over a 10.2 MB base) and this section does not
record whether Chrome ran with `--enable-precise-memory-info`, without which `performance.memory` is coarse, so that miss
is weak evidence either way; T27 re-measures it. The thresholds stand as written.

Three ways to draw a file's diff behind the `DiffCodeView` seam (`web2/src/components/diffs/`) were built and measured
against the thresholds in [`T25-diff-renderer-spike.md`](T25-diff-renderer-spike.md). The thresholds were fixed before
any measurement.

- **A** `@pierre/diffs` 1.5.2 (the version T3 pins; T3 also patches it, a 44 KB patch not applied here) with its worker
  pool, shiki 4.5.0, JS regex engine (`preferredHighlighter: "shiki-js"`; the WASM engine is never requested).
- **B** a hand-rolled renderer on `parsePatch` with **highlight.js 11.12.0** (core and one grammar per language, loaded on
  demand). The spec's other option, a shiki JS-engine subset (core, engine, one theme, TypeScript), bundles to 73.8 KB
  gzip (357.7 KB raw) against 10.9 KB for highlight.js core plus TypeScript; both are pure JS with no WASM, and
  highlight.js is BSD-3-Clause with no dependencies, so it was taken.
- **C** the status quo: `DiffLines` with no highlighter, line numbers, split or expansion.

**Device and method.** Not a phone. Chrome 155.0.8059.40 (headless, so no occluded-window frame throttling) on the
Windows dev machine, driven with `ca` over CDP: `Emulation.setDeviceMetricsOverride` 390 x 844, device scale factor 2,
mobile; `Emulation.setTouchEmulationEnabled` (so `pointer: coarse` is true, checked in the page);
`Emulation.setCPUThrottlingRate` 4 (calibration: a 3e7-iteration loop takes 28 ms at rate 1 and 157-173 ms at rate 4);
`Network.emulateNetworkConditions` with DevTools' Fast 4G numbers (165 ms latency, 1,012,500 B/s down, 168,750 B/s up),
and `Network.setCacheDisabled` for the cold rows. The page is `spike-diffs.html` from a `SIGHTR_DIFFS=<adapter>` build,
served by a dev bridge (port 8792) so the response headers are the production ones, CSP included
(`script-src 'self'; worker-src 'self'`, no `wasm-unsafe-eval`). `tailscale serve` was not in front
(`SIGHTR_SKIP_SERVE=1`); the service worker ran on `http://127.0.0.1`, which is a secure context. Every "on Bart's phone"
figure is **pending real-phone trial (after T27)**; none is measured here, and none fails a candidate by itself.
Medians of 5 fresh page loads (3 for the 3,000-line file). jsdom figures rank only.

How each row was read:

- **Sizes** are gzip (zlib default) of every emitted `.js`, from `vite build` with the seam imported by the main entry
  (a two-line edit to `src/main.tsx`, reverted) against the same build without it. Main chunk: seam, `DiffLines` and
  `Suspense` only; `parsePatch` stays in the adapter chunk. Lazy chunk: the JS files the page actually fetched to open one
  `.ts` file (adapter, theme, worker, grammar), looked up in the build.
- **Cold open**: fresh page, cache off, Fast 4G, first diff of the session: `import("diffs-adapter")` plus everything the
  adapter then fetches until its own lines are in the DOM. **The bridge serves static JS uncompressed** (response
  `transferSize` equals the file size, also with `Accept-Encoding: gzip`), so the phone downloads the raw bytes and every
  gzip row understates the cold fetch.
- **First render**: a mount in a page where the adapter chunk, the Suspense boundary and (A) the worker pool are already
  warm, from `root.render` until the adapter's own lines are in the DOM (`paint` adds two animation frames). "First diff
  of a session" is a fresh page with the files in the HTTP cache: it includes a hold of about 300 ms before the adapter replaces the Suspense fallback (12-26 ms
  warm against 340-468 ms for B and C; consistent with React's 300 ms reveal throttle) and, for A, booting the worker pool.
  The hold is in the seam, so it is the same for every candidate; T27 can preload the adapter.
- **Large patch**: (a) the 40-file patch with its first file open (an ordinary 113-line file; files render on open) and
  (b) the same patch with the 3,000-line, 400-character-line file open. A row passes on (a), as the spec words it
  (files rendered on open); where (b) fails the cell says so.
- **Commits and renders**: counted through the DevTools global hook (`onCommitFiberRoot`, fibers with `PerformedWork`) in
  the production build and in jsdom. **DOM nodes**: every element under the mount, shadow roots included. **Heap**:
  `performance.memory.usedJSHeapSize` after three forced GCs, the main thread only (A's worker heap is not counted).
- **Jank**: `Input.synthesizeScrollGesture` touch flings (1,400 px at 2,500 px/s, alternating) for 5 s while a
  `requestAnimationFrame` loop logs frame intervals. Scrolling is compositor-driven, so this is main-thread cadence; a
  frame over 25 ms counts as dropped.
- **Worker and CSP**: `securitypolicyviolation`, `error`, `unhandledrejection` and `console.error` were collected from the
  first line of the page over every load; the app's own service worker was registered, allowed to precache and claim, and
  the spike page opened under it. A broken worker was simulated two ways (a `Worker` whose `error` event fires, and one
  whose constructor throws); Chrome's `Network.setBlockedURLs` does not reach worker script fetches.
- **Touch**: gutter `getBoundingClientRect` plus the `::after` hit area, under `pointer: coarse`; text `user-select`;
  horizontal page scroll with wrap on and off. Reading order (old before new) is read from the DOM, not with a screen
  reader: B puts the old gutter, the new gutter and then the code in each row (split: the old half, then the new half),
  and A's unified layout lists a change's removals before its additions.

<!-- diff-spike:table -->
Device and method: Chrome 155 headless on Windows 11 via ca (CDP), 390x844 CSS px, DPR 2, mobile + touch emulation (pointer: coarse), Emulation.setCPUThrottlingRate 4, Network.emulateNetworkConditions = DevTools Fast 4G (165 ms, 1,012,500 B/s down, 168,750 B/s up) with cache disabled for cold rows; served by a dev bridge with the production CSP; real phone: pending real-phone trial (after T27). Measured 2026-10-18.

| Measure | Pass | A: @pierre/diffs 1.5.2 (shiki 4.5.0, JS regex engine) | B: hand-rolled + highlight.js 11.12.0 | C: status quo DiffLines at this commit |
|---|---|---|---|---|
| Licence of the package and every runtime dependency | MIT, Apache-2.0, BSD or ISC | Apache-2.0 (@pierre/diffs, theme, theming); BSD-3-Clause (diff); MIT or ISC for the other 40 (lru_map: MIT in its manifest, no LICENSE file) (pass) | BSD-3-Clause (highlight.js 11.12.0); no runtime dependencies (pass) | no new package (pass) |
| Main chunk gzip growth (seam and Suspense) | <= +2 KB | +0.69 KB (+689 B) (pass) | +0.70 KB (+696 B) (pass) | +0.67 KB (+667 B) (pass) |
| Lazy chunk gzip: renderer, worker, grammars for one language | <= 150 KB | 471.6 KB for one .ts file: pierre 144.0 KB, lib 6.1 KB, pierre-dark 4.6 KB, pierre-light 4.6 KB, worker 296.3 KB, typescript 15.9 KB (FAIL) | 14.6 KB for one .ts file: hand 3.7 KB, core 7.9 KB, typescript 3.0 KB (pass) | 0.7 KB for one .ts file: status 0.7 KB (pass) |
| Total dist JS gzip growth | <= +400 KB (or grammars left out of precache) | +2284.3 KB (322 new JS files); 244 grammar chunks = 1802.7 KB, so +481.5 KB with them out of the precache (+252.7 KB with the unused wasm chunk out too) (FAIL) | +34.2 KB (16 new JS files); 12 grammar chunks = 19.6 KB, so +14.6 KB with them out of the precache (pass) | +3.2 KB (2 new JS files) (pass) |
| Cold fetch of the lazy chunk (median of 5, SW cleared) | <= 1.0 s cold, <= 100 ms warm | cold open 3267 ms (module graph 752 ms, 2593.5 KB on the wire, uncompressed), warm graph 20 ms; phone: pending real-phone trial (after T27) (FAIL) | cold open 540 ms (module graph 198 ms, 227.0 KB on the wire, uncompressed), warm graph 4 ms; phone: pending real-phone trial (after T27) (pass) | cold open 521 ms (module graph 194 ms, 191.4 KB on the wire, uncompressed), warm graph 4 ms; phone: pending real-phone trial (after T27) (pass) |
| First render, 50 / 1,500 lines (390 px, 4x CPU) | <= 50 ms / 300 ms | 50 lines 58 ms (paint 124 ms); 1,500 lines 1194 ms (paint 2138 ms); first diff of a session 2274 ms (FAIL) | 50 lines 12 ms (paint 53 ms); 1,500 lines 176 ms (paint 205 ms); first diff of a session 468 ms (pass) | 50 lines 26 ms (paint 51 ms); 1,500 lines 267 ms (paint 284 ms); first diff of a session 340 ms (pass) |
| First paint of first file, large patch | <= 800 ms, no long task > 250 ms | (a) first file 308 ms, longest task 122 ms; (b) 3,000-line x 400-char file 6912 ms, longest task 36227 ms [(b) fails]; phone: pending real-phone trial (after T27) (pass on (a), FAIL on (b)) | (a) first file 152 ms, longest task 108 ms; (b) 3,000-line x 400-char file 185 ms, longest task 103 ms; phone: pending real-phone trial (after T27) (pass) | (a) first file 41 ms, longest task 0 ms; (b) 3,000-line x 400-char file 1645 ms, longest task 90 ms [(b) fails]; phone: pending real-phone trial (after T27) (pass on (a), FAIL on (b)) |
| React commits for one first render | <= 3, no loop | browser: 1 file 2, large first file 2, 3 files 2; jsdom: 2/1/1/1 (50/1,500/large/3,000-line); renders 7; stable=true (pass) | browser: 1 file 2, large first file 2, 3 files 4; jsdom: 3/5/2/2 (50/1,500/large/3,000-line); renders 6; stable=true (pass) | browser: 1 file 1, large first file 1, 3 files 1; jsdom: 2/1/1/1 (50/1,500/large/3,000-line); renders 4; stable=true (pass) |
| Scroll jank, large patch, 5 s fling | p95 frame <= 20 ms, <= 10% dropped | (a) first file p95 18.3 ms, 0% dropped, over 20 ms 0% (301 frames, 5.26 s); (b) 3,000-line file p95 18.3 ms, 2.8% dropped, worst frame 70.3 ms (pass) | (a) first file p95 18.1 ms, 0% dropped, over 20 ms 0% (304 frames, 5.29 s); (b) 3,000-line file p95 18.2 ms, 0% dropped, worst frame 18.7 ms (pass) | (a) first file p95 18.2 ms, 0.3% dropped, over 20 ms 0.3% (301 frames, 5.26 s); (b) 3,000-line file p95 18.4 ms, 0.3% dropped, worst frame 52.8 ms (pass) |
| Mounted DOM nodes, large patch | <= 5,000 | (a) first file 1,931; (b) 3,000-line file 616,965 [(b) fails]; 1,500 lines (3 files) 24,201; jsdom, every row mounted: 746/18,579/1,535/485,413 (pass on (a), FAIL on (b)) | (a) first file 947; (b) 3,000-line file 6,872 [(b) fails]; 1,500 lines (3 files) 2,507; jsdom, every row mounted: 404/11,611/947/12,365 (pass on (a), FAIL on (b)) | (a) first file 203; (b) 3,000-line file 3,198; 1,500 lines (3 files) 1,581; jsdom, every row mounted: 61/1,581/203/3,198 (pass) |
| Heap, large patch (Chrome) | <= +60 MB, within 20% of baseline after unmount | (a) first file +1.1 MB (after unmount 0.1 MB over a 14.7 MB base); (b) 3,000-line file +183.9 MB (after unmount 10 MB over 11.4) [(b) fails]; main thread only, a worker's heap is not counted (pass on (a), FAIL on (b)) | (a) first file +3 MB (after unmount 0.3 MB over a 9.2 MB base); (b) 3,000-line file +47.5 MB (after unmount 2.1 MB over 10.2) [(b) fails]; main thread only, a worker's heap is not counted (pass on (a), FAIL on (b)) | (a) first file +0.8 MB (after unmount 0.1 MB over a 5.7 MB base); (b) 3,000-line file +5.1 MB (after unmount 0.6 MB over 6.1); main thread only, a worker's heap is not counted (pass) |
| Worker under the bridge CSP, SW active | 0 violations, same-origin worker, no WASM, falls back | 0 CSP violations or console errors over 31 loads; worker: same-origin file /assets/worker-CCSOkt84.js, 2 pool workers; wasm requests 0; broken worker (error event, and a throwing constructor): plain lines shown at 21 ms / 17 ms, no throw; @pierre/diffs logs 3 console.error lines itself when its worker fails (nothing throws); service worker active and controlling (372 precache entries), 0 violations, worker served from the SW cache (transfer 0 B) (pass) | 0 CSP violations or console errors over 31 loads; worker: none (main thread); wasm requests 0; broken worker (error event, and a throwing constructor): n/a (no worker); service worker active and controlling (66 precache entries), 0 violations (pass) | 0 CSP violations or console errors over 31 loads; worker: none (main thread); wasm requests 0; broken worker (error event, and a throwing constructor): n/a (no worker); service worker active and controlling (52 precache entries), 0 violations (pass) |
| Split, expand-unchanged, line annotations behind the seam | native or <= 150 adapter lines | split yes, expand yes, annotations yes (contract suite passes); pierre.tsx 121 lines (pass) | split yes, expand yes, annotations yes (contract suite passes); hand.tsx 119 lines (+ hand.rows.ts, hand.highlight.ts, hand.langs.ts) (pass) | split no, expand no, annotations no; status.tsx 22 lines (FAIL) |
| Highlight coverage of the corpus's changed files | >= 90% | 93.0% of the top-12 extensions by count, 92.3% of all 2903 changed files in git history (93.3% of text files) (pass) | 93.0% of the top-12 extensions by count, 92.5% of all 2903 changed files in git history (93.6% of text files) (pass) | 0.0% of the top-12 extensions by count, 0.0% of all 2903 changed files in git history (0.0% of text files) (FAIL) |
| Touch and accessibility | 44 px gutter, selectable, old-then-new order, no page h-scroll | gutter 67.4 x 20 px, hit area 67 x 44 px under pointer: coarse=true; text selectable true; page h-scroll wrap false / no-wrap false (pass) | gutter 44 x 20 px, hit area 44 x 44 px under pointer: coarse=true; text selectable true; page h-scroll wrap false / no-wrap false (pass) | no gutter (no tap target); text selectable true; page h-scroll wrap false / no-wrap false (FAIL) |

- A: fails lazy-gzip, dist-gzip, cold-fetch, first-render; passes on (a) but fails on (b): large-paint, dom, heap (0 row(s) n/a or pending)
- B: every decidable row passes; passes on (a) but fails on (b): dom, heap (0 row(s) n/a or pending)
- C: fails features, coverage, touch-a11y; passes on (a) but fails on (b): large-paint (0 row(s) n/a or pending)
<!-- /diff-spike:table -->

**Ranks for the decision rule.** Lazy gzip for one `.ts` file: C 0.7 KB, B 14.6 KB, A 471.6 KB. First paint of the first
file of the large patch: C 41 ms, B 152 ms, A 308 ms. A fails four rows on its own numbers (lazy chunk, total `dist`
growth, cold open, first render), so the rank step is not reached: on (a) B passes every decidable row. On the harder
reading, with the 3,000-line file open (b), B also fails mounted DOM nodes (6,872 against 5,000, mostly highlight spans
on 400-character lines) and, by a hair, heap after unmount (2.1 MB over a 10.2 MB base is 20.6%, against 20%); A fails
(b) on paint (6.9 s, a 36 s long task), nodes (616,965) and heap (+184 MB); C fails (b) on paint (1.6 s). The `Cell`
marks in the table separate the two readings.

What bears on T27 to T29:

- **A**: `PatchDiff` is not virtualised, and its `Virtualizer` brings its own scroller; T3 virtualises the whole file list
  with `CodeView`, which the one-file seam cannot offer. The worker is a same-origin Vite `?worker` file (837 KB raw,
  296 KB gzip) and zero CSP violations occurred with the service worker active and without it; if the worker cannot start
  the adapter shows plain lines (the library logs three `console.error` lines when that happens). The build also
  emits a 232 KB gzip `shiki/wasm` chunk that is never requested (the JS engine is used) and 244 grammar chunks
  (1.8 MB gzip), all of which the service worker would precache: 372 precache entries against 66 for B. Leaving
  grammars out with `globIgnores` still leaves +481 KB, over the +400 KB limit.
- **B**: needed windowing to pass. Before it, 1,500 lines took 879 ms and mounted 11,582 nodes (1,205 ms before colours
  moved from inline `style` to classes); now rows mount in 60-row windows as they come within 800 px of the screen.
  Costs: browser find sees only mounted rows, lines revealed by "expand unchanged" are not highlighted, and T29
  scroll-to-line needs mount-on-demand. `hand.tsx` is 119 lines; the row model, highlighter and extension table add
  `hand.rows.ts`, `hand.highlight.ts` and `hand.langs.ts`.
- **All**: the seam's main-chunk cost is 0.67 to 0.70 KB gzip; `DiffCodeView` shows `DiffLines` while the adapter loads.
  `parsePatch` replaces `parseDiff` for hunk-aware numbering (a removed line starting `-- `, quoted names, CRLF, no
  newline at EOF, rename, binary); `gitPatchPath.ts` is T3's, verbatim at `6a6ebb27`.
- jsdom ranking data (commits settled / nodes with every row mounted): A 2, 1, 1, 1 / 746, 18,579, 1,535, 485,413;
  B 3, 5, 2, 2 / 404, 11,611, 947, 12,365; C 2, 1, 1, 1 / 61, 1,581, 203, 3,198 (50 lines, 1,500 lines, large first file,
  3,000-line file).
- Not measured: a real phone (any row), `tailscale serve` in front, A with T3's patch, A inside `CodeView`, a shiki
  adapter for B (size only), the Tailscale route's cold fetch.

**What T27 to T29 inherit from this decision.**

- **T27 flips the default, and only once reading (b) passes.** `diffs-adapter` becomes `adapters/hand.tsx`;
  `highlight.js` is added to `web2/package.json` pinned at exactly `11.12.0` (BSD-3-Clause, no runtime
  dependencies), and `hand.tsx` and `hand.highlight.ts` leave the `tsconfig.json` exclude. That is the one new
  dependency T27's "any new dependency" exclusion yields to. Before the flip, T27 re-runs `spike-diffs.html?auto=large-worst` with the method above
  (Chrome started with `--enable-precise-memory-info --js-flags=--expose-gc`, flags recorded) and appends the result
  here; it must show at most 5,000 mounted nodes, heap within 20% of base after unmount and no long task over 250 ms.
  The changes that get it there, all in the adapter:
  - a window closes at 60 rows or 12,000 characters of line text, whichever comes first (a 400-character file gets about
    30 rows), and only the first window mounts at once; the rest mount by `IntersectionObserver` as today;
  - highlighting runs per window as it mounts, not for the whole file up front, and in slices of at most 200 lines per
    `highlight` call, so an added or deleted 3,000-line file (one hunk; not in the fixture) is never one long task. A
    multi-line token cut at a slice edge shows plain; highlight.js 11 has no continuation state;
  - nothing highlight-related outlives the component (the per-file map is component state; only the registered grammars
    stay, module-level);
  - in the panel, an open file other than the first or the revealed one mounts even its first window on intersection,
    since T27 opens all files when there are 3 or fewer and their eager windows add up.
- **T27 preloads the renderer.** The first diff of a session spends about 300 ms in the `Suspense` fallback before the
  adapter shows (React's reveal throttle; the same for every candidate). The seam exports a `preloadDiffRenderer()` that
  calls `import("diffs-adapter")`, and the Diff panel calls it on mount (T24's card may call it too).
- **Windowing caveats, accepted and stated in T27.** Browser find (Ctrl+F) sees only mounted rows. Unmounted windows
  hold an estimated 20 px per row, which is low for wrapped long lines, so the scrollbar shifts as windows mount; scroll
  memory restores to a file header plus an offset, not a raw `scrollTop`. The service worker precaches B's 16 new files
  (+34.2 KB gzip); no `globIgnores` line is needed.
- **T28 uses the seam's existing names and builds into `hand.rows.ts`.** The seam already has `layout`, `onExpandContext`
  and `capabilities.split` / `.expand`; T28 uses them instead of its draft's `expand` object and `supports`. Split and
  expand are native to B in T28's sense, so `diffSplit.logic.ts` and `diffGaps.logic.ts` are not separate panel files:
  T28's gap rules (20-line steps, show all, old/new gap-length check, `\r?\n` splitting, the staleness guard, no tail
  control on a truncated patch) go into `hand.rows.ts` (today it reveals a whole gap at once and keeps a trailing `\r`),
  and T28's fixtures run at the seam. Revealed lines are highlighted through the same per-window path (today they are
  plain).
- **T29 extends the seam for its three needs.** Gutter action: `onLineAction(at)` gains a second argument
  `{ shiftKey: boolean }`. Selection: a new optional prop `selection?: { side: DiffSide; start: number; end: number }`
  that `hand.tsx` marks on its rows. Annotation under a range: the existing `annotations` / `renderAnnotation`, with `at`
  the range's last line. Scroll-to-line needs mount-on-demand: the target's window mounts first, then the line scrolls
  into view after layout. The 44 px gutter is wide enough, but its `pointer-coarse:after:-inset-y-3` hit area overlaps
  the next row on 20 px lines, and later rows paint on top, so by CSS paint order a tap on the lower part of a number
  lands on the line below (found by reading the CSS, not measured). T29 drops the vertical extension (44 px wide is
  T29's own rule) or resolves the line from the pointer's position.
- **Follow-ups outside T27 to T29.** The bridge serves static JS uncompressed even with `Accept-Encoding: gzip`, so
  every cold fetch is the raw bytes and the gzip rows understate it (B's cold open moved 227.0 KB). Compressing `/assets/*.js` is
  a bridge slice, with the cold rows re-measured after. The real-phone trial (cold fetch over `tailscale serve`, large
  paint, scroll) runs after T27 and is appended here; a row that fails on the phone is fixed in `hand.tsx`.

Re-measure: `bun add -d --no-save @pierre/diffs@1.5.2 highlight.js@11.12.0` in `web2`; `bun scripts/diff-spike.ts
fixtures`; `SIGHTR_DIFFS=hand|pierre|status bunx vite build --outDir <temp>` (add `SIGHTR_DIFFS_PAGE=0` to leave
`spike-diffs.html` out for the size rows); copy the three fixtures into `<temp>/fixtures/<name>.json` as `{"patch": ...}`;
open `spike-diffs.html?auto=small|medium|large-first|large-worst` with the throttling above. `bun scripts/diff-spike.ts
jsdom <adapter>` runs the jsdom harness and `report --results <file> --write` rebuilds the table above.
Fixture language mix: `threads.sqlite` was not present on the build machine, so the top-12 extensions come from `git log
--name-only` of this repository (ts, tsx, md, txt, json, png, css, toml, ps1, html, example, jpg); `fixtures --source
<threads.sqlite>` reads it when there is one.

## Diffs series (T24–T31, decided 18 Oct 2026)

Bart reversed the earlier "no per-turn diffs, no checkpoints" line. T3's diff work reaches Sightr as a
series of its own, in this order (value first), one spec per run, bridge before web2:

1. **T24** changed-files card per run, from the journal (no git).
2. **T25** renderer spike, decided from numbers (as T23 was). T27–T29 code against a `DiffCodeView` seam, so the choice stays swappable.
3. **T26 + T27** the review API and the diff panel: working tree, branch vs a picked base, file tree.
4. **T28** split view (≥ 1024 px only), ignore whitespace, expand unchanged lines.
5. **T29** line comments that land in the plain-text composer as quoted text. No Tiptap.
6. **T30 + T31** git checkpoints for exact per-run diffs, then the UI that prefers them over the journal.

How a session builds it (waves, which model does what, the per-slice loop, gates): [`DIFFS-RUNBOOK.md`](DIFFS-RUNBOOK.md).

Rules for the whole series:

- **Read-only.** No stage, revert, commit, push, rollback or worktree creation. Nothing is ever written into a user's repository. T30 keeps its snapshots in a private bare repo under Sightr's state dir (on by default, with an opt-out), and stores each run's patches in `threads.sqlite` so archived runs still show their diffs.
- **Never take, still:** `@pierre/trees` (a beta; the tree is local code), Effect atoms and RPC (plain fetch to the bridge), Tiptap, T3's PR-diff and review-guide components, T3's mobile review module.
- **Ledger.** The `skip` decision on T3's `DiffPanel.tsx` and `DiffFileStatus.tsx` is reversed by the slice that ports each file.

## Not in this series

- Worktree creation, rollback, commit/push/PR (T3 §5). Herdr owns worktrees, and Sightr never writes git state. Per-turn diffs and checkpoints moved to the diffs series above.
- Resuming an archived thread into a new pane. That is a follow-up once T07 lands; Claude, Pi and Codex can resume by session id.
- Multi-environment pairing, a native app and a relay.
- Row 4 of the council set (whistlr wizard). Marked operator-decision cards keep going through `whistlr reply`.
- Free-text dialog answers (Claude's plan feedback, Pi's type-in row, preview notes). They stay in the Terminal tab.

## Decided with Bart (16 Oct 2026)

- **herdr floor:** v2 needs herdr 0.9.0 or later for everything, not only spawn. The bridge checks the version once at start-up. Below 0.9.0 the `/api/v2/*` routes answer 503 with the reason, and v1 keeps working.
- **v1 at cutover:** v1 moves to `/v1/` and keeps its routes (snapshot SSE, pane polling) for one release. The next release removes both.
- **Launch pickers:** each harness gets a short list of suggested models plus free text. Flags come only from T07's table, never from the client. Cursor and Codex flags stay empty until someone checks them on a machine that has those CLIs.
- **Bypass modes** (`bypassPermissions` and the like) are offered on the phone too, behind two confirmations. The bridge refuses them without `confirmBypass: true`.
- **No live model switch for Claude** (17 Oct 2026): `/model` also rewrites the user's global default model, so Claude's model is chosen at spawn only.
