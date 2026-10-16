# T06 — Dispatch, queue and steer

Status: draft (T3-shape series). Depends on: T01 (store, receipts), T02 (threads, status, interim capability table), T03 (run boundaries), T04 (runtime requests), T05 (command endpoint, events).

## Problem

Today a send is a client action. The phone calls `POST /api/pane/:id/send` (spec 24) and gets a `ReplyOutcome`.
There is no "send this when the agent is done", no way to stop the agent and redirect it, and nothing that
survives a closed tab. T3 has all three: `start`, `queue` and `steer`, with the queue held on the server.
Sightr v2 needs the same on top of herdr panes, where the bridge owns the send path but not the agent.

## Change

One command, `message.dispatch`, and three small ones around it. All run through T05's `POST /api/v2/command`
and the receipt row makes each idempotent.

### `message.dispatch {threadId, text, attachments?, mode: "start" | "queue" | "steer"}`

The bridge reads the thread's status from the projection and picks the path. The client's `mode` is the
intent; a mismatch is answered, not guessed.

- **`start`** (thread `idle` or `done`). Runs the guarded send core from spec 24 inside the pane write queue
  (`queue.run(paneKey(paneId), …)`). It reuses `runGuardedSend` with the same `GuardedSendIo` that
  `guardedSendPane` builds. That wiring moves into a shared helper, `createGuardedSender(herdr, cfg, engine, queue)`
  in `bridge/guarded-send-route.ts`, so the HTTP route and the dispatcher call one function. The v1 route keeps
  its behaviour.
- `start` on a `working` thread is rejected with `thread-busy`; the client re-sends as `queue` or `steer`.
- `start` on a thread whose status is `approval` or `input` (a blocked pane or `dialogDetected`) is rejected with
  `needs-response`. Answering the dialog belongs to T04's `runtime-request.respond`. Nothing is typed.
- `start` on `failed` is allowed like `idle`.
- `start` on `archived` is rejected with `thread-archived`.
- On a `starting` thread (T07 is spawning it), `start` and `steer` are rejected with `thread-busy`, and `queue`
  inserts a row as on a working thread. The drainer sends it once the thread settles. T14 sends a new thread's
  first message this way.
- **`queue`** inserts a row in `queued_messages` (below) and emits `queue.updated {change: "added"}`. It does not touch the pane.
  `queue` on an idle thread with an empty queue degrades to `start` (no queue row is written).
- **`steer`** (thread `working`): see Steer below. On an idle thread it degrades to `start`.
- Attachments: the existing upload route (`uploadPane`) already writes a file and returns a path. Dispatch takes
  those paths and appends them to the text the same way the v1 composer does. Attachments are stored with the queued
  row as `{path, name}` and never re-uploaded.
- The reply is T05's `{sequence}`. Outcomes (`sent`, `blocked`, `stalled`, `error`) arrive as events. A `sent`
  emits nothing of its own: T03 emits `run.started` when the status turns `working`. Any other outcome emits
  `dispatch.failed {reason, textDelivered?, queuedId?}`. A `stalled` or `blocked` start
  leaves the text out of the queue: the user sees the failure and decides.

### Queue

T01's `queued_messages` table (created by its migration 1; this slice adds no migration):

`queued_messages(id TEXT PK, thread_id, text, attachments_json, position INTEGER, mode TEXT, state TEXT, held_reason, created_at)`,
with `state` in `queued | sending | held`.

- **Drain.** A `QueueDrainer` in `bridge/threads/queue-drain.ts` (new) listens to thread status events. When a thread
  becomes settled it takes the lowest `position` row with `state = queued`, marks it `sending`, runs the `start`
  path, and on `sent` deletes the row and emits `queue.updated {change: "sent"}`. One message per settle: the next drains only after
  the run that message started has ended.
- **Settled** means projection status `idle` or `done` *after* `STATUS_HOLD_MS` (3 s, `state-engine.ts`). The
  engine already holds `working` through the hold, so a `done` between two tool calls never reaches the projection
  as settled. The drainer adds no timer of its own for that. It does add a guard: before sending, re-read the pane
  and run the harness's `composerReady`; if the composer is not on screen it waits for the next status event.
- **Per harness.** The drainer never reads harness ids. It uses the thread's `capabilities.canQueueDrain`
  (T01 name; T02's interim table sets it true for agent harnesses and false for a plain shell). A thread with false
  has no queue; `queue` mode is refused with `queue-unsupported`.
- **Failure.** If `start` returns `blocked` or `stalled`, the row returns to `queued` at the same position and the
  drainer backs off until the next status event. Three failures in a row set `state = held` and emit
  `queue.updated {change: "held", reason}`. An `error` with `textDelivered: true` deletes the row (the text is in the box) and
  emits `dispatch.failed`.
- **Restart.** On bridge start every `queued` or `sending` row becomes `held`. The drainer does not send held
  rows. `queue.resume {threadId}` (new command) flips them back to `queued` in order and emits
  `queue.updated {change: "resumed"}`. A `sending` row at crash time is ambiguous (text may be in the box), so it
  loads with `heldReason: "restart"`, and the UI shows the
  text for the user to decide. T3 holds its queue the same way.
- **Edit and reorder.** Both are plain store writes and never touch the pane.

### Steer

`steer` is `run.interrupt`, then wait for settled, then `start`. The whole sequence holds the pane write queue's
turn only for the interrupt and the final send; the wait between them does not hold it (a long wait must not block
`keys` taps; `PANE_QUEUE_TIMEOUT_MS` is 10 s).

1. Row inserted with `mode = steer` at position 0, `state = sending`, so a plain `queue` row cannot overtake it.
2. `run.interrupt` (below).
3. Wait for the thread to reach `idle` or `done` for `STEER_WAIT_MS = 15_000`. It subscribes to the same status
   events as the drainer.
4. On settle, run `start`. On timeout, emit `dispatch.failed {reason: "interrupt-timeout", queuedId}` and move the row back to
   `queued` position 0, state `held`, so nothing is lost and the user can retry or cancel.

### `run.interrupt {threadId}`

Sends the harness's interrupt keys through `sendKeysPaced` inside the pane write queue. Keys come from the
thread's `capabilities.interruptKeys`, never from a branch on the id. This slice adds `interruptKeys` and
`canInterrupt` to T02's interim table (`bridge/threads/capabilities.ts`) from the table below; T08 later moves
the whole table into `shared/agents.ts`. A row ships `canInterrupt: true` only once the live check below passes
for that harness:

| Harness | Interrupt keys | Basis |
|---|---|---|
| claude | `Escape` | the TUI's own hint; unverified for Sightr's send path |
| pi | `Escape` | unverified |
| grok | `Escape` | unverified; `ctrl+c` may quit |
| cursor | `ctrl+c` | its composer shows "ctrl+c to stop" (`cursor/chrome.ts`); a second press may exit, send once |
| agy | `Escape` | unverified |
| codex | `Escape` | unverified |

Rules: one interrupt per call, no repeat. Only while status is `working`. If a runtime request is open, refuse with
`needs-response`. Mark the open run row when the key is sent; T03 then ends that run with `run.ended`
`{status: "interrupted"}` when the status leaves `working`. This slice emits no run event of its own. Harnesses with `canInterrupt = false` refuse with `interrupt-unsupported`.

### `queued.reorder {threadId, ids[]}`, `queued.edit {id, text}`, `queued.cancel {id}`

Store writes in one transaction each. `edit` of a `sending` row is refused with `already-sending`. `cancel` of a
`sending` row is refused the same way. Each emits `queue.updated` with `change` `reordered`, `edited` or `cancelled`.

### Events (payloads in `shared/v2/contracts.ts`)

`queue.updated {messages, change, reason?}` (T01's name; `change` is `added | sent | held | resumed | reordered |
edited | cancelled`) and `dispatch.failed`. Run events are T03's. For a harness with a journal (`hasJournal`), the
T03 journal ingestor owns the user turn item and dispatch links the run to it by the text it sent. For one without,
dispatch appends the `user_message` item itself on `sent` (T03, `screen` items).

## Invariants

- Every pane write goes through the pane write queue. Spec 24's invariants hold unchanged: no composer, no typing;
  submit only after the text shows.
- A blocked thread never receives a dispatch. Approvals are answered, never talked past.
- A queued message is sent at most once. A row leaves the table only on `sent`, `cancel`, or `textDelivered`.
- After a restart nothing is sent until the user resumes.
- The drainer sends one message per settle.
- Dispatch makes no decision on harness id; it reads capability flags.

## Tests

Bridge, with a fake Herdr and a fake clock (`bridge/threads/dispatch.test.ts`, `queue-drain.test.ts`):

- start on idle types, verifies, submits; emits no run event (T03 starts the run on `working`).
- start on working returns `thread-busy`; on blocked returns `needs-response` with nothing written; on archived refuses.
- queue on a working thread inserts a row and writes nothing; queue on idle degrades to start.
- two queued rows drain one at a time: the second waits for the run the first started to end.
- a `done` that flips back to `working` inside the hold does not drain.
- drain backs off when the composer is not ready; three `stalled` results hold the row.
- `error` with `textDelivered` deletes the row; `blocked` leaves it in place.
- restart: rows load as `held`, nothing is sent, `queue.resume` releases them in order; a `sending` row loads held with reason `restart`.
- steer: interrupt key goes out once, text is sent only after settle; timeout holds the row at position 0.
- interrupt marks the open run; a fake status change to `idle` makes T03's ingestor end it `interrupted`.
- steer with an open runtime request is refused; interrupt on an unsupported thread is refused.
- reorder/edit/cancel update positions and emit events; edit of a `sending` row is refused.
- an idempotent replay of the same `commandId` inserts one row.
- a shell thread refuses queue.
- the v1 `/api/pane/:id/send` tests (`guarded-send.test.ts`) pass unchanged after the helper extraction.

Live, in a scratch workspace: queue two messages on Claude while it works and watch both land in order; steer on
Claude; interrupt on Cursor. Record the other harnesses as not live-tested if not installed.

## Notes for the planner

- Spec 24's route finds the pane through `engine.current()`. The dispatcher has a thread id, not a pane id, so it
  resolves `paneId` from the projection and must also check `terminalId` against the engine's pane to catch a reused
  pane.
- T3's README row says "Steer = interrupt key, wait idle, send". Wait time is not specified there; `STEER_WAIT_MS` is
  proposed.
