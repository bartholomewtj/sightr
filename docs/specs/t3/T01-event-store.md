# T01 — The v2 contracts and the event store

Status: done on feat/v2 (2026-10-16). Depends on: nothing. Read `README.md` in this folder first (Domain, Commands).

## Problem

Sightr v1 has no store. The bridge holds the herd in memory (`StateEngine`) and a few JSON files
(`activity.json`, `pane-claims.json`). Everything the v2 series needs — shelves, pins, snooze, queued
messages, runs, turn items, command receipts, a sequence number a client can resume from — must survive a
bridge restart and be written atomically with the event that caused it. This slice builds that store and the
shared types. It ingests nothing and serves nothing.

## Change

- **`shared/v2/contracts.ts`** (new). Types only, plus tiny pure helpers. No Node or Bun API, no imports
  outside `shared/`, so `web2/` and the bridge both load it.
  - Every type in the README "Domain" section: `Project`, `Thread`, `ThreadStatus`, `Shelf`, `Run`,
    `TurnItem` (a discriminated union on `type`), `RuntimeRequest`, `QueuedMessage`, `ThreadEvent`.
  - `THREAD_STATUS_RANK: Record<ThreadStatus, number>` (`approval` 0 … `idle` 5, then `starting` 6: T07 sets it on a pane it is spawning, and it never
    outranks a real status) and `worstStatus(list)`.
  - `ThreadCapabilities`, the final set (names owned by T08):
    `{ hasJournal, canQueueDrain, canInterrupt, interruptKeys?, canSwitchPermissionMode, permissionModes?,
    canSwitchModel, modelCommand?, canSetEffortLive, effortCommand?, resumeBySession, launchModes }`.
    The `can*`/`has*` fields and `resumeBySession`, `launchModes` are booleans; the optional ones are string
    lists or a slash command. There is no steer flag: steer needs `canInterrupt && canQueueDrain`. T02 fills it
    from an interim table, T06 adds the interrupt rows, T08 moves the table into `shared/agents.ts`.
  - `Command`, a union on `type` with the README command list, each with `commandId: string`. Additions from
    later slices, listed here so the union is complete: `queue.resume {threadId}` (T06); the `thread.create`
    fields in T07; `project.create {cwd, label?}` (T07); `thread.permissionMode.set {threadId, mode, confirmBypass?}`
    and `thread.model.set {threadId, model}` (T08); `optionIndices?` on `runtime-request.respond` (T17).
  - `ThreadEventType` and one payload type per event, below.
  - `Thread.sessionRef` on the wire is `{ kind: "id"; value: string }` only. A `path` ref stays server-side
    (the rule `toPaneWire` already keeps in `bridge/snapshot-route.ts`). The full ref lives in the
    `threads.session_ref_json` column.
  - Additions to the README shapes, all optional unless noted: `Project.closedAt?` (a workspace that closed while
    archived threads still point at it); `Thread.archiveReason?` (`pane-closed`, `terminal-replaced`,
    `closed-while-down`, `spawn-failed`); `Thread.permissionMode?` and `Thread.model?` (T08, last confirmed
    value); `RuntimeRequest.via?: "whistlr"` and `RuntimeRequest.decision?: { thread, run }` (T04);
    `RuntimeRequest.options[].description?`, `steps?`, `preview?`, `multiSelect?`, `answers?` (T17);
    `QueuedMessage.state` (`queued | sending | held`, required) and `heldReason?` (T06). The shell snapshot's
    request summary has no `options`.
- **Events.** Names fixed here so T02–T05 agree: `project.upserted`, `project.closed`,
  `thread.created`, `thread.updated` (a patch of title, harness, status, unreadDone, lastActivityAt,
  capabilities, sessionRef, terminalId, permissionMode, model), `thread.shelf-changed {shelf, snoozeUntil?, pinOrder?}`, `thread.archived`,
  `run.started`, `run.ended`, `turn-item.updated` (upsert by id), `runtime-request.updated`,
  `queue.updated {messages}`, `command.rejected {reason}`. Later slices use these names, extend one and add two:
  `queue.updated` also carries `change` (`added | sent | held | resumed | reordered | edited | cancelled`) and
  `reason?` (T06); `dispatch.failed {reason, textDelivered?, queuedId?}` (T06);
  `thread.create.failed {threadId, stage, message}` (T07). A permission-mode or model change is a
  `thread.updated` patch (T08), and an interrupted run is `run.ended` with `status: "interrupted"` (T03).
- **`bridge/threads/store.ts`** (new). `bun:sqlite`, one file at `join(cfg.stateDir, "threads.sqlite")`.
  - `openThreadStore(path, opts?: { now?, newId? })`. `":memory:"` is allowed for tests.
  - Pragmas on open: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=2000`.
  - **Tables** (all created by migration 1): `meta(key, value)`; `events(sequence INTEGER PRIMARY KEY
    AUTOINCREMENT, thread_id, command_id, type, payload_json, ts)` with an index on `(thread_id, sequence)`;
    `projects`; `threads` (the Thread fields, plus `terminal_id`, `title_source` `herd|user`,
    `session_ref_json`, unique on `(pane_id, terminal_id)`); `runs`; `turn_items(id PRIMARY KEY, thread_id,
    run_id, position, type, body_json, updated_sequence)` with an index on `(thread_id, position)`;
    `runtime_requests` (adds `bound_text`, never sent to clients); `queued_messages(id, thread_id, text,
    attachments_json, position, mode, state, held_reason, created_at)` (T06 uses it);
    `command_receipts(command_id PRIMARY KEY, type, sequence, result_json, ts)`;
    `journal_offsets(thread_id PRIMARY KEY, path, offset, size, mtime_ms, session_key)`.
  - **Migrations.** `migrations(version, applied_at)`. An ordered array of `{ version, up(db) }`, each run in
    its own transaction. A database whose highest version is newer than the code's refuses to open
    (`StoreTooNewError`); the bridge then leaves v2 off and says why. `PRAGMA user_version` mirrors it.
  - **Corrupt file.** If open or `PRAGMA quick_check` fails, rename to `threads.sqlite.corrupt-<ts>`, start
    empty, and log once. The projection is rebuilt from the herd by T02; history and shelves are lost, which
    is the accepted cost.
  - **Append API.** `store.append(drafts: EventDraft[], opts?: { commandId?, receipt? }): { first: number; last: number }`.
    One `BEGIN IMMEDIATE` transaction: insert each event, apply its projection with `applyEvent(tx, event)`
    (a switch on `type`, the only code that writes projection tables), write the receipt row when given,
    commit. All or none. After commit, call the `onCommitted(events)` listeners (T05 fans out from this).
    A throw in a listener never rolls anything back.
  - **Reads.** `snapshotShell()`, `snapshotThread(id, { runs })`, `eventsAfter(sequence, { threadId?, limit })`,
    `receipt(commandId)`, `lastSequence()`, `minSequence()`, `offsets.get/set`. Plain objects, no ORM.
  - **Retention** (`store.prune(now)`, called hourly by the bridge and once at open): keep events newer than
    7 days or the newest 50 000, whichever is more; `meta.min_sequence` records the oldest kept sequence so a
    replay request below it is answered with a snapshot. Delete receipts older than 7 days. Cap `turn_items`
    at 5 000 per thread (oldest first, never an item of an open run). Delete threads archived over 90 days
    ago, with their items and runs. Run `PRAGMA wal_checkpoint(TRUNCATE)` after a prune. If the main file
    passes 256 MB after pruning, log a warning; nothing else changes.
- **`bridge/threads/decide.ts`** (new). `decide(state: DecideState, command: Command, ctx: { now: number; newId: () => string }): Decision`.
  Pure: no I/O, no clock, no random. `DecideState` is what the command needs (the thread row, the project
  row, `paneAlive`). `Decision` is `{ ok: true; events: EventDraft[]; result?: unknown } | { ok: false; reason: string; code: "not_found" | "invalid" | "conflict" }`.
  This slice implements the commands that only change the projection: `thread.rename` (sets
  `title_source = user`), `pin`/`unpin`, `snooze` (rejects a past time), `settle`/`unsettle`,
  `archive`/`unarchive` (unarchive is refused when `paneAlive` is false), `markRead`/`markUnread`,
  `project.rename`. Every other command type returns `{ ok: false, code: "invalid", reason: "unsupported" }`
  here; T05 routes those to their effect handlers (T06–T08).
- **State directory.** Reuse `Config.stateDir` (`resolveStateDir` in `bridge/beacon/paths.ts`:
  `HERDR_PLUGIN_STATE_DIR`, then `SIGHTR_STATE_DIR`, then `~/.local/state/sightr`). `bridge/index.ts` already
  creates the directory at mode 0700 before anything opens; the new file is created by SQLite, so chmod it to
  0600 after open on platforms where that is meaningful and ignore the error on Windows.
- **`bridge/index.ts`.** Open the store after `mkdir(cfg.stateDir)`, close it in `shutdown`. `SIGHTR_V2=0`
  skips opening. T02 and T05 take the store from here; nothing else in this slice reads it.

## Invariants

- The sequence is global, strictly increasing, and never reused (AUTOINCREMENT). Gaps are allowed.
- An event and its projection change commit together or not at all. No code outside `applyEvent` writes a
  projection table.
- Replaying every event from an empty database reaches the same projection (a test pins this for the
  event types this slice defines).
- `decide()` never reads a clock, a random source or the database.
- `bound_text` and full session refs never appear in any `snapshot*` return value.
- The store file never leaves `cfg.stateDir`; no path comes from a request.

## Tests

Temp directory per test (`mkdtemp`), or `:memory:` where the file does not matter.

- **Migrations:** a fresh open reaches the latest version; reopening is a no-op; a database stamped with a
  higher version throws `StoreTooNewError`; a truncated file is renamed aside and replaced.
- **Append:** a batch gets consecutive sequences; a failing projection (a forced constraint error) leaves no
  event row; a duplicate `commandId` receipt makes the second append throw and write nothing.
- **Replay equivalence:** append a scripted event list, dump the projection, rebuild into a second store from
  `eventsAfter(0)`, compare.
- **Reads:** `eventsAfter` honours `threadId` and `limit`; `minSequence` moves after `prune`.
- **Retention:** with fake `now`, old events, receipts, items over the cap and 90-day archived threads go;
  an open run's items stay.
- **decide():** table-driven, one row per command including each rejection; a test calls it twice with the
  same input and compares deep equal.
- **Contracts:** `worstStatus` order; the `Command` and `ThreadEventType` unions list every name in this spec
  (a compile-time exhaustiveness check).
- **Typecheck:** `shared/v2/contracts.ts` imports nothing, so the root typecheck passes before the web install.

## Notes for the planner

- Pruning and the 256 MB warning are the cuttable part. If the run is long, ship migrations, append, reads
  and `decide()`, and leave `prune` as a follow-up; nothing in T02–T05 needs it to work.
- `Thread.sessionRef` is narrowed to id refs on the wire (README lists it unqualified). Say so if that is wrong.
- `bun:sqlite` needs no dependency, but `bun test` for `./bridge` must run on a Bun with it. Bun is already
  the runtime, so this holds.

## Built

Files: `shared/v2/contracts.ts`, `bridge/threads/{events,store,decide}.ts` with tests beside them,
`bridge/test/thread-fixtures.ts`, the store opened and closed in `bridge/index.ts`.

Deviations from the draft:

- **Turn items mirror T3** (Bart, 16 Oct): `TurnItem` follows T3's `OrchestrationV2TurnItem` (upstream
  `e3b35d1b`) instead of `tool_call {toolKind}`. Base `{ id, threadId, runId: string|null, ordinal, status, title,
  startedAt, completedAt, createdAt, updatedAt, truncated? }`, `status` is T3's `TurnItemStatus` (tool items use it
  for running/completed/failed). Kinds: `user_message`, `assistant_message`, `reasoning`, `command_execution`,
  `file_change`, `file_search`, `web_search`, `dynamic_tool`, `approval_request`, `user_input_request`,
  `system_notice {message}`, `error {failure, retry?}`, plus Sightr's `session {from, to}` and
  `screen {text, capturedAt}`. T3 kinds with no terminal source (plans, checkpoints, handoffs, forks, subagents,
  notifications, secrets) are left out. T03 maps tool names to the kinds: shell → `command_execution`, edit/write →
  `file_change`, grep/glob → `file_search`, web → `web_search`, anything else (read included) → `dynamic_tool`.
- **Times** are epoch ms everywhere (T3 sends ISO strings).
- **Thread names follow T3** where cheap: `snoozedUntil` (not `snoozeUntil`), plus `pinnedAt`, `settledAt`,
  `updatedAt`, `titleSource`. `shelf` and a numeric `pinOrder` stay Sightr's. `thread.shelf-changed` is
  `{shelf, snoozedUntil?, pinOrder?, at}`; it is also how a thread leaves `archived` (unarchive), and it clears the
  previous shelf's fields. `Run` uses `completedAt` (not `endedAt`).
- **Project** gains `status` (the roll-up T02 emits) and `labelSource` (`project.rename` sets `user`; T02 must not
  overwrite a user label).
- **`archiveReason: "user"`** added for `thread.archive`.
- Every event payload carries the time it needs (`at`, `closedAt`, `completedAt`), so replay never reads `ts`.
  `turn-item.updated` may omit `ordinal`; the store gives a new item the next one and writes it into the stored event.
- **Server vs wire.** `bridge/threads/events.ts` holds the server forms (`ServerThread` with path refs,
  `boundText` on `runtime-request.updated`). `eventsAfter`, `onCommitted` and both snapshots return the wire form
  (`toWireEvent`); `storedEventsAfter` returns the server form for replay only.
- **Extra reads** for T02/T05: `getThread`, `getProject`, `listThreads`, `listProjects`, `maxPinOrder`;
  `append(..., { offsets })` saves journal offsets in the same transaction (T03). `DecideState` has
  `maxPinOrder` so `thread.pin` stays pure.
- `decide()`: a command that is already true (pin a pinned thread, archive an archived one) is `ok` with no
  events. Rename, pin, snooze and settle on an archived thread are `conflict: archived`.
- `minSequence()` is 0 until a prune deletes something. `prune` is called once at open and hourly from
  `bridge/index.ts`. `SIGHTR_V2=0` is read in `bridge/index.ts`, not `Config`.
- Foreign keys: threads → projects; runs, items, requests, queue and offsets → threads with cascade, so pruning a
  thread removes its rows.
