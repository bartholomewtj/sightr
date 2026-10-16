# T06 — Dispatch, queue and steer

Status: done on feat/v2 (2026-10-16). Depends on: T01 (store, receipts), T02 (threads, status, interim capability table), T03 (run boundaries), T04 (runtime requests), T05 (command endpoint, events).

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

## Built

Files: `bridge/threads/dispatch.ts` (handlers for `message.dispatch`, `run.interrupt`, `queued.reorder|edit|cancel`,
`queue.resume`, registered as T05 effects in `index.ts`), `bridge/threads/queue-drain.ts` (`createQueueDrainer`),
`createGuardedSender` in `bridge/guarded-send-route.ts` (the v1 route now calls it; `guarded-send.test.ts` unchanged
and green), `INTERRUPT_TABLE` in `bridge/threads/capabilities.ts`, store reads `listQueued(threadId?)` and
`getQueued(id)`. Tests: `dispatch.test.ts`, `queue-drain.test.ts` (the hold test drives a real `StateEngine` and herd
ingest).

Deviations and additions:

- **Refusals** keep T05's codes; the spec's names are the `error` text: `409 conflict` with `thread-busy`,
  `needs-response`, `thread-archived`, `pane-gone`, `already-sending`, `queue-changed`, `not-working`,
  `already-interrupting`; `409 unsupported` with `queue-unsupported` / `interrupt-unsupported`; pane busy `503 busy`
  (no receipt). A start whose send was refused by the guard (`blocked`, `stalled`, `error`) still answers
  `200 {sequence}` with a receipt; the outcome is the `dispatch.failed` event.
- **`dispatch.failed`** gained an optional `message` (the guard's own words). `reason` is `blocked` | `stalled` |
  `error` | `pane-gone` | `busy` | `interrupt-failed` | `interrupt-timeout`.
- **Retry timer.** The drainer backs off on a status event as specified, and also retries a backed-off thread after
  `DRAIN_RETRY_MS` (5 s) while it stays settled. Without it a composer that was briefly covered (a picker the operator
  closed) or a stalled send on a pane that stays idle would wait forever. Only `blocked`/`stalled`/`error` count toward
  the three strikes; composer not on screen and pane busy do not. A held row is never retried.
- **One message per settle** is tracked from just before the send (a `working` seen while the send is still
  verifying counts) until the status goes `working` and back. A run too fast for a poll to see releases the next row
  after `RUN_WAIT_MS` (20 s). A late `run.ended` of an older run does not release it.
- **`textDelivered`** deletes the row and schedules no retry: the next row waits for a status change, so the drainer
  never sweeps the operator's half-sent text.
- **Closed pane.** When a thread is archived its rows are held with `heldReason: "pane-closed"` (T12's "Not sent: pane
  closed"); rows never leave the table on their own.
- **Restart** holds `queued` rows too, with `heldReason: "restart"`, not only `sending` ones (T12 shows one Resume).
- **Steer.** The row's insert commits with the receipt and the reply returns at once; interrupt, wait and send run in
  the background. A steer whose send fails is held at position 0 with the outcome as its reason (not retried). A
  resumed steer row drains like a queue row.
- **Double interrupt.** Live, two `run.interrupt` 140 ms apart sent two Escapes and Claude opened its rewind menu.
  After a press, further presses are refused with `already-interrupting` until the status leaves `working` (or
  `INTERRUPT_REPEAT_MS`, 15 s). A steer in that window waits for the stop without pressing again.
- **`canInterrupt`** ships for Claude only (live-checked). Pi, Grok, Cursor, Agy and Codex keep their keys in
  `INTERRUPT_TABLE` with `verified: false`; not live-tested.
- **No-journal threads** get a `user_message` item (`id dispatch:<uuid>`, `inputIntent` `turn_start` |
  `queued_turn` | `steer`) on `sent`; T03 adopts it into the run. For journal threads nothing extra was needed:
  T03 already links the run to the logged message.
- The drainer's composer check is `GuardedSender.composerReady` (one read in its own queue turn). It parses with
  `web/src/lib/blocks.ts`'s `parseLines`, a new direct bridge import of a file already in the guard's closure.

Live (16 Oct 2026, scratch workspace `v2-test-T06`, Claude Code 2.1.301 on Haiku, test bridge on port 8796):

| Case | Result |
|---|---|
| start on idle | sent (0.2–5 s; the first send waited for Claude's box) |
| queue two while working | rows held in order; ALPHA sent when the run ended, BRAVO after ALPHA's run ended |
| steer mid-output | one Escape, run ended `interrupted`, text sent 4 s later (the engine's 3 s hold), answered |
| steer 0.3 s into a run | Claude put the interrupted prompt back in the box (118 chars); the sweep is capped at 96 keys, so the box kept a tail and the steer stalled, was held at position 0 with `stalled`, nothing submitted |
| run.interrupt | one Escape, run ended `interrupted`; a second press 140 ms later refused `already-interrupting` (after the fix) |
| restart with a queued row | row loaded `held` / `restart`, nothing sent; `queue.resume` sent it |
| queued.cancel | removed a held steer row |

Open: a steer that lands before the agent has output anything leaves a long restored prompt in Claude's box that
the 96-key sweep cannot clear; the guard holds the steer safely, but a future slice may want a per-harness clear
(Claude's input) or a larger cap for that case.
