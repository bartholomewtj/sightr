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
| Worktrees, checkpoints, diff panel, commit/push/PR | **Out of scope** for this series | herdr owns worktrees; read-only git status stays |
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

## Not in this series

- Worktree creation, checkpoints, per-turn diffs, rollback, commit/push/PR (T3 §5). Herdr owns worktrees, and Sightr's Git panel stays read-only.
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
