# T05 — The v2 API: commands, shell stream, thread stream, history

Status: draft (T3-shape series). Depends on: T01, T02, T03, T04.

## Problem

T01–T04 fill a store with events. Nothing serves them. v2 clients need one idempotent command endpoint, two
resumable SSE streams, a paged history read, and a guarantee that none of this is offered on a herdr too old
to support it. v1 routes must keep working untouched (they stay for one release after cutover, T15).

## Change

- **Herdr floor** (decided with Bart: 0.9.0 for everything in v2).
  - `bridge/herdr-client.ts` (the only file that names Herdr methods): add `serverVersion(): Promise<string>`,
    which returns `sessionSnapshot().version`. A server that predates `session.snapshot` throws "unknown
    variant"; that is reported as version `"<0.7"`, below the floor.
  - `bridge/threads/herdr-floor.ts` (new). `HERDR_FLOOR = "0.9.0"`, `parseHerdrVersion(s)` (leading
    `major.minor.patch`, ignores a `-preview` or `+build` suffix, so `0.9.0-preview` meets the floor),
    `meetsFloor(s)`, and `createV2Gate()`: `{ state(): "pending" | "ok" | "too-old"; reason(): string; check(herdr): Promise<void>; whenOk(fn) }`.
  - `bridge/index.ts` runs `gate.check(herdr)` once, right after the existing `herdr.ping()` at start-up. If
    Herdr is unreachable then, the check runs once on the first `engine.onLink("connected")`. After one
    successful check the result is fixed for the life of the process. A restart after upgrading herdr re-checks.
  - The T02 ingestor, T03 ingestor and T04 ingestor start inside `gate.whenOk(...)`. Below the floor nothing
    ingests and the store stays empty.
  - Every `/api/v2/*` route answers `503` with JSON `{ ok:false, code:"herdr-too-old", error:"v2 needs herdr >= 0.9.0 (found <version>)", have, need }`
    while the gate is `too-old`, and `{ ok:false, code:"v2-starting", error }` while `pending`. v1 routes never
    look at the gate. T09 keys its full-screen state on `code`.
  - `SIGHTR_V2=0` (T01) answers `503 { ok:false, code:"v2-disabled", error }`.
- **`bridge/threads/v2-routes.ts`** (new). `createV2Routes(deps)` returns `handle(req, url): Promise<Response> | null`
  (null = not a v2 path). Deps: `cfg, store, gate, herdr, engine, activity, queue (the process pane queue), audit, conn, effects`.
- **Route table** (`bridge/server.ts`, in `fetch`): one line after `workdir.owns(...)` and before the
  `/api/snapshot` line:
  `if (pathname.startsWith("/api/v2/")) return v2.handle(req, url) ?? text("not found", 404);`
  The lock gate (`lockGate`) and the loopback-peer check already run above it. Create `v2` beside `paneWrites`
  (reusing that same queue instance, so v1 writes and v2 commands serialise on one pane). No v1 line changes.
- **`POST /api/v2/command`.** Access: `guard(req, cfg, "write")`, the same as every write route, then
  `requireJsonBody`. Body `{ commandId, type, ... }`; `commandId` is 1–64 chars of `[A-Za-z0-9_-]`.
  1. Look up the receipt. Same `commandId` and same type and body hash → return the stored reply with 200
     (idempotent). Same id, different body → `409 { ok:false, code:"conflict" }`.
  2. Resolve the key: thread-scoped commands use `paneKey(thread.paneId)`, project/global ones use
     `v2:project:<id>`. Run the rest inside `queue.run(key, …)`; `PaneBusyError` → `503 pane busy`, as v1.
  3. Re-check the receipt (a duplicate may have won the wait), build `DecideState` from the store and
     `engine.current()` (`paneAlive`), and call `decide()` (T01). A pure command gets its events from it.
  4. An effectful command (`message.dispatch`, `queued.*`, `queue.resume`, `run.interrupt`, `thread.create`,
     `thread.model.set`, `thread.permissionMode.set`, `project.create`) goes to `effects[type]`, a registry that
     T06–T08 fill. This slice registers one entry, `runtime-request.respond` (T04). A type with no handler
     answers `501 { ok:false, code:"unsupported" }`.
  5. `store.append(events, { commandId, receipt })`. Reply `{ ok:true, sequence }` (200): the intent
     committed, not that the work finished. Validation failures (bad type, unknown thread, `decide` rejection)
     answer 400/404/409 with `{ ok:false, code, error }` and write no receipt, so a corrected retry can reuse the id.
     A rejection found *after* work started (for example `prompt-changed`) appends `command.rejected` with a
     receipt, and replies 409.
  6. After a command that changed "seen" (`markRead`, `markUnread`), call `herdIngestor.reconcile(engine.current())`.
  - Audit with `auditFor(req)`: a `v2-command` record with `{ type, threadId }`, never message text beyond what
    the existing `send` record already keeps. (`bridge/audit.ts` has a closed action list; add the entry there.)
- **`GET /api/v2/shell` (SSE).** `guard(req, cfg, "read")`. Frame ids are sequences.
  1. `Last-Event-ID` or `?after=`: if `0 < after <= lastSequence`, `after >= minSequence` and at most 128
     events exist after it, replay them as `event: event`. Otherwise send `event: snapshot` with
     `{ sequence, projects, threads, requests }` (request summaries: id, threadId, kind, prompt, status; no
     options and no bound text), no replay.
  2. Then `event: synchronized` `data: {"sequence":N}`, then live events from `store.onCommitted`.
  3. Heartbeat parity with `bridge/events-route.ts`: every `SSE_KEEPALIVE_MS` (15 s) of silence send
     `: keep-alive` and `event: ping` with `{"sequence":N}`. The phone's watchdog (`connection-health.ts`,
     `CONNECTION_LOST_MS`) treats a quiet stream as dead exactly as it does for v1, so no new client rule.
  4. `?client=<id>` replaces an older stream from the same client (as `createSnapshotEvents.attach` does) and
     feeds the same `conn.bridge({ kind: "sse.attach" | "sse.detach" })` telemetry, so `/sightr-conn` stays comparable.
  5. Headers as v1: `content-type: text/event-stream`, `cache-control: no-store`, `x-accel-buffering: no`.
  6. Backpressure: a client more than 1 MB behind is closed after an `event: reset`; it reconnects with its
     last id and gets a replay or a snapshot.
  7. Also emit `event: build` once, like v1, so the PWA build-swap check works on v2 pages.
- **`GET /api/v2/thread/:id` (SSE).** Same gate, framing, heartbeat and backpressure, scoped to one thread.
  - Replay when the cursor is within the thread's last 128 events (`eventsAfter(after, { threadId, limit: 129 })`
    returns at most 128 and `after >= minSequence`); otherwise `event: snapshot`
    `{ sequence, thread, runs, items, requests, queue, historyCursor }` with the last 10 runs' items.
    An `after` greater than `lastSequence` (the database was reset) also snapshots.
  - Unknown thread id → 404 before streaming. An archived thread streams its stored history and then idles.
  - Attaching registers a watcher (`watchers.add(threadId)`), which makes T03 read the journal while it is
    open; detaching removes it. Attach also calls `activity.noteSeen` once, under the same cross-site rule as
    v1's `marksPaneSeen` (read it in `bridge/access.ts`; a forged cross-site GET must not mark a thread seen).
- **`GET /api/v2/thread/:id/history?before=<cursor>&limit=`.** `guard(..., "read")`. Returns
  `{ runs: [{ run, items }], loose: TurnItem[], nextCursor: string | null }`, oldest-first. `limit` is runs,
  default 5, max 20. The cursor is an opaque string (the base64 of the oldest returned item's `position`).
  An unknown or malformed cursor answers an empty page with `nextCursor: null` (spec 09's rule). Items
  with no run are returned in `loose` for the page's position range. Responses go through `json()` for gzip.
- **Unchanged.** `/api/snapshot`, `/api/events`, `/api/pane/*` and every other v1 route keep their code and
  tests. Nothing here removes them; their removal is the release after T15.

## Invariants

- No `/api/v2/*` route answers 2xx below herdr 0.9.0; v1 answers as before.
- A `commandId` is applied once. Retrying after a lost response returns the first reply and writes nothing.
- Two commands for one pane never interleave with each other or with a v1 write: they share one queue key.
- Every write route needs the same access as v1 writes; every stream and history route the same as v1 reads.
- A stream never sends an event whose sequence is not greater than the last one it sent.
- A replay is never longer than 128 events; beyond that the client gets a snapshot.
- `bound_text`, session paths and receipts' bodies never appear in a stream frame.

## Tests

Temp sqlite, a fake Herdr whose `serverVersion` is settable, a fake engine, `Request` objects through
`handle()` (the pattern in `events-route.test.ts` and `server.test.ts`).

- **Floor:** `parseHerdrVersion` on `0.9.0`, `0.9.0-preview`, `0.10.1`, `1.0.0`, `0.8.9`, garbage; gate
  `too-old` → every v2 path 503 with the reason while `/api/snapshot` still 200; unreachable at start →
  `pending` 503, then `ok` after the link comes up; the check runs once.
- **Auth:** read-only access gets 403 on `POST /api/v2/command` and 200 on the streams; the lock gate and
  device auth apply as on v1.
- **Command:** a pure command commits and returns the sequence; the same `commandId` twice returns the same
  reply with one event; same id with a different body → 409; unknown thread → 404; unsupported effect → 501;
  two parallel commands on one pane run in order (assert through a queue spy); `PaneBusyError` → 503.
- **Shell stream:** fresh attach → snapshot, `synchronized`; resume with a recent id → replay only, in order;
  resume 200 behind → snapshot; resume below `minSequence` → snapshot; resume ahead of last → snapshot;
  `event: ping` after the injected clock passes the keep-alive; a same-`client` reattach closes the old stream.
- **Thread stream:** replay scoped to the thread; events of other threads never appear; watcher count goes up
  and down with attach/detach; archived thread streams history; a slow consumer is reset.
- **History:** paging walks back to `nextCursor: null` with no duplicate and no gap; unknown cursor → empty;
  limit clamps at 20; items with no run come back in `loose`.
- **Regression:** the existing `events-route.test.ts`, `server.test.ts`, `snapshot-route.test.ts` pass unchanged.
- **Live (scratch workspace only):** start a bridge on a spare port with its own state dir, create a thread by
  opening a shell tab, attach the shell stream with `curl -N`, rename the thread by command, see the event.

## Notes for the planner

- This is the largest slice. If it must be cut: ship the floor, the command endpoint with pure commands plus
  `respond`, and the shell stream; leave the thread stream's snapshot assembly and the history route to a
  follow-up. T09 can start on the shell stream alone.
- `HerdrClient.serverVersion()` costs one `session.snapshot` at start. If a lighter call exists in 0.9.0
  (check `herdr api schema --json`), prefer it; the contract is only "return a version string".
- The README says the floor check could sit in T01. It is here because it gates routes and ingestors, which
  are wired in this slice.
- `RuntimeRequest` needs additions the README does not list: `via?: "whistlr"` and `decision?` (T04) and, on
  the summary shape in the shell snapshot, no `options`. T01's `contracts.ts` lists them.
