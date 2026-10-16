# T02 — Herd ingest: workspaces to projects, panes to threads

Status: draft (T3-shape series). Depends on: T01.

## Problem

The herd lives only in `StateEngine`'s memory and is pushed whole to v1 clients. v2 needs it as events: a
project per workspace, a thread per pane, status changes, and an archive when a pane goes. It also needs
the thread identity the README fixes, `(paneId, terminalId)`, and the bridge does not carry `terminal_id`
past `toView` today.

## Change

- **Carry `terminal_id`.** `bridge/herdr-client.ts` `WirePane` already has `terminal_id`.
  `bridge/state-engine.ts` `toView` drops it. Add `terminalId?: string` to `AgentView` (not to `PaneCommon`),
  set in `toView` from `p.terminal_id` for both agent and shell panes. `toPaneWire` in
  `bridge/snapshot-route.ts` strips it with `agentSession`, so the v1 wire is unchanged. Existing
  `state-engine.test.ts` fixtures already carry `terminal_id: "term"`.
- **`bridge/threads/herd-ingest.ts`** (new). `createHerdIngestor({ store, engine, activity, journals, now, newId })`
  returns `{ start(), stop(), reconcile(snap) }`.
  - `start()` subscribes to the engine: `onUpdate(snap => reconcile(snap))`, `onRemove(paneId => gone.add(paneId))`
    and `onTransition(agent => touched.set(agent.paneId, now()))`. The engine fires `onTransition` and
    `onRemove` before `onUpdate` in one poll, so they only annotate; `reconcile` is the single writer.
    `touched` gives `lastActivityAt` the transition time; the ledger's `activeAt` is the fallback.
  - `reconcile(snap)` builds the desired state, calls the pure `diffHerd(snap, projection, ctx)`, and passes the
    result to one `store.append`. No event when nothing changed. It never runs while `snap.bridge` is
    `disconnected` (the engine does not call listeners then anyway).
  - Subscribe in `bridge/index.ts` after `engine.onTransition(... activity.noteActive ...)`, so the ledger is
    already updated when the ingestor reads it.
- **Projects.** One per `snap.workspaces[]` entry: `id = workspaceId`, `label`, `number`, `order = number`,
  `worktreeOf = worktree.repoKey` when `isLinkedWorktree`. Emit `project.upserted` on create or change. A
  workspace that disappears gets `project.closed` (sets `closedAt`); the row stays while archived threads
  point at it.
- **Threads.** Over `snap.agents` and `snap.shellPanes` (a shell is a thread too, harness `shell`).
  - Key: `(paneId, terminalId)`. A pane with no `terminalId` (a very old herdr) keys on `(paneId, "")`.
  - New key: `thread.created` (shelf `active`, `unreadDone` false, `createdAt = now`). The same `paneId` with a
    new `terminalId` archives the old thread (`archiveReason: "terminal-replaced"`) and creates a new one.
  - **Adopt T07's pre-created thread.** T07 emits `thread.created` with status `starting` and no
    `terminalId` for a pane it is spawning, before `agent.start` finishes. When reconcile sees a pane whose
    `paneId` matches a non-archived thread with an empty `terminalId`, it adopts that thread: one
    `thread.updated` fills `terminalId` (and harness, title, status) and no second thread is created. Adoption
    applies only to an empty `terminalId`; a different non-empty one is the terminal-replaced case above.
    `starting` is a valid thread status here (T01 lists it, T07 sets it); T02 never emits it. The
    dispatcher (T06) works from `threadId` and re-checks `terminalId` against the engine's pane before writing.
  - `harness` is `canonicalAgent(agent)` from `shared/agents.ts`; unknown agents keep their raw string.
    A change (an agent exits and leaves a shell, or one is started) is a `thread.updated` patch. It is not a
    new thread: the pane and terminal are the same.
  - `title`, while `title_source = herd`: `paneLabel` > `sessionName` > `agentName` > `terminalTitle` >
    `summary` > `"<harness> · <tabLabel or cwd basename>"`. A `thread.rename` flips the source to `user`.
  - `capabilities` (the T01 `ThreadCapabilities` names) come from `capabilitiesFor(harness)` in a small interim
    table, `bridge/threads/capabilities.ts`: `hasJournal` is `adapterFor(journals, harness) !== undefined`,
    `canQueueDrain` is true for an agent harness and false for `shell`, every other flag false. T06 adds the
    interrupt rows; T08 moves the table into `shared/agents.ts` and this file becomes a re-export.
  - `sessionRef` comes from `AgentView.agentSession`. Only a change is an event; the session divider itself is T03.
- **Status mapping.** `thread.status` is derived, not copied:
  - herdr `working` → `working`.
  - herdr `blocked` (including the engine's `dialogDetected` verdict) → `input`, or `approval` once T04 has
    an open request of kind `permission` or `trust`. Until T04 exists, every blocked pane is `input`.
  - `done`/`idle`/`unknown` → `done` while `unreadDone`, else `idle`.
  - `failed` is never set here. T03 sets it when a run ends with an `error` item, and it clears when the
    next run starts.
  - The engine has already applied `STATUS_HOLD_MS` and the dialog sniff, so this reads the published status.
- **Project roll-up.** `worstStatus` over the project's threads whose shelf is `active` or `pinned`. Snoozed,
  settled and archived threads do not count. Emitted as `project.upserted` only when the value changes. The
  order is `approval · input · failed · working · done · idle` (`THREAD_STATUS_RANK` from T01).
- **unreadDone and ADR 0003.** `activity.json` stays the single source of "seen" (one shared, bridge-wide
  stamp; blind to the desk). A thread is `unreadDone` exactly when the ledger says `status === "done" &&
  activeAt > seenAt` for its pane, which is the v1 rule. So v1 and v2 never disagree. Consequences:
  - Opening a thread over v2 (the thread SSE attach in T05) and `thread.markRead` call `activity.noteSeen`.
  - `thread.markUnread` calls `activity.noteActive` (which only reads as unread while the status is done).
  - A v1 read of the same pane clears it for v2 on the next poll.
  - Because `noteSeen` fires between polls, T05 calls `herdIngestor.reconcile(engine.current())` right after
    a seen change rather than waiting up to one poll interval.
- **Pane close → archived.** A key present in the projection and absent from `snap` (no pane with that
  `paneId`) for two consecutive reconciles becomes `thread.archived` (`archiveReason: "pane-closed"`), with
  any open run ended `interrupted` and any pending runtime request `expired`. The two-poll grace covers a
  one-off partial `session.snapshot`. `onRemove` marks the key so the second look is not skipped, but a
  pane that merely stopped being an agent (it still exists as a shell) is not removed.
- **Snooze expiry.** Each reconcile also emits `thread.shelf-changed` back to `active` for any snoozed thread
  whose `snoozeUntil <= now`. A thread that finishes work while snoozed or settled returns to `active`.
- **Restart reconciliation.** The first `reconcile` after start is the same function. Every non-archived
  thread whose key is not in the herd is archived at once (no grace; the bridge was down so the herd is the
  truth), `archiveReason: "closed-while-down"`. If herdr is unreachable at start, no `onUpdate` fires and the
  store is left alone.

## Invariants

- A pane id is never reassigned to an existing thread by `paneId` alone; `terminalId` decides.
- Reconcile is idempotent: the same snapshot twice appends nothing.
- A thread is archived only because its pane is gone (or replaced), never because the agent exited.
- Shelf, pin, snooze and `user` titles set by commands survive every reconcile and every restart.
- The ingestor never writes `activity.json` except through `noteSeen`/`noteActive`, and never calls Herdr.
- A first sighting never marks a thread unread (same rule as the ledger's `ensure`).

## Tests

Fake engine (a stub with `onUpdate`/`onRemove`/`onTransition` and a settable snapshot), temp sqlite, fake
`activity`, injected `now`/`newId`.

- **diffHerd (pure, table-driven):** new pane → project + thread events; unchanged snapshot → none; title
  precedence; harness change patches rather than creating; user title not overwritten; snooze expiry.
- **Adoption:** a `starting` thread with empty `terminalId` plus a snapshot pane with that `paneId` → one
  `thread.updated`, one thread total; a thread with a different non-empty `terminalId` is not adopted.
- **Identity:** same pane, new terminal id → old archived, new created; missing terminal id keys on `""`.
- **Status:** each herdr status, `dialogDetected` blocked, done with and without unread; project roll-up
  across mixed threads, ignoring snoozed and archived ones.
- **Unread:** transition to done makes `unreadDone`; `noteSeen` clears it on the next reconcile; first
  sighting is read; `markUnread` on an idle thread leaves it idle.
- **Close:** one missing poll keeps the thread; two archive it, end the open run, expire the request.
- **Restart:** seed the store with three threads, start with a herd holding one, expect two archived and
  `closed-while-down`; herd empty at start with the engine disconnected changes nothing.
- **state-engine.test.ts:** `terminalId` reaches `AgentView` for agent and shell panes; the v1 `toPaneWire`
  output has no `terminalId`.

## Notes for the planner

- `engine.onRemove` fires only for agent panes (it is derived from `prevStatus`); shell panes vanish without
  it. The diff covers both, so `onRemove` is only a hint. Do not rely on it.
- The README says "any pane is a thread". Shell panes are included here with harness `shell`; cut them
  (agents only) if the sidebar would be too noisy. T10 can also filter on harness.
- An agent exiting inside a living pane keeps the thread (status `idle`, harness `shell`). The README only
  says a closed pane archives; this is the reading chosen here.
