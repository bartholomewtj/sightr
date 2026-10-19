# Plan: pane visibility + close-pane command (GitHub #112)

Source: the run contract (`C:\Users\barth\.draftr\runs\fa858ea7\contract.md`). Every item below is from it; nothing dropped, nothing added.

Rules: web2 never branches on a harness id. Keep the bridge's `web/src` import closures free of react/@shared. Tests only use mocks; no live herdr, no real pane closed or typed into. Do not edit CONTEXT.md, DECISIONS.md, STATE.md, draftr.toml, .github/. Add one line under `## [Unreleased]` in CHANGELOG.md (`### Added`). Where the spec is ambiguous, follow the code's conventions and name the choice in the commit message.

## 1. Contracts — `shared/v2/contracts.ts`

- `Thread` gains `paneAlive?: boolean`; `ThreadPatch` (line ~712, a `Partial<...>`) must allow it. `true` = Herdr's live snapshot lists this `paneId` with matching `terminalId`; `false`/absent = not listed.
- `Command` union (near line 644): add `| (CommandBase & { type: "thread.pane.close"; threadId: string })`. Add `"thread.pane.close"` to `VALID_COMMAND_TYPES` (near line 690). Check the receipt type map: receipt is `{ type: "thread.pane.close", result: { hash } }`.
- `bridge/threads/v2-routes.ts` has a per-command field-shape table (near line 232, e.g. `"thread.delete": { threadId: "string" }`): add `"thread.pane.close": { threadId: "string" }`. It is NOT a pure command (it needs the herdr effect), so leave it out of `PURE_COMMANDS`.
- Check the server-side thread type (`ServerThread`) and the reducer/projection that applies `thread.updated` patches so `paneAlive` is carried through, and the web2 store applies it too (grep `applyPatch`/`thread.updated` in `web2/src/stream`).
- Test: `bridge/threads/contracts.test.ts` — `thread.pane.close` is in `VALID_COMMAND_TYPES` (follow how existing types are asserted).

## 2. Bridge ingest — `bridge/threads/herd-ingest.ts` (`diffHerd`)

- New thread created from a live pane (line ~230): set `paneAlive: true`.
- Live-thread update loop (line ~273): add `if (current.paneAlive !== true) p.paneAlive = true;` into the patch.
- Archived revival path (line ~259, `pane-closed`/`closed-while-down` pane came back): it runs `shelfActive` then falls into the patch loop, so the same line sets `paneAlive: true`. A user-archived thread whose pane is still live currently `continue`s before the patch loop; before that `continue`, if `current.paneAlive !== true` emit a `thread.updated` `{ paneAlive: true }` patch (so a thread archived while alive reads true). Use the existing `patch()` helper.
- `archive()` helper (line ~195-203): the archived thread must end with `paneAlive: false` for `reason` `pane-closed`/`closed-while-down`/`terminal-replaced`. For `user` archive (decide.ts) the pane stays alive, so do not touch it. Emit `paneAlive: false` as part of the same event batch for the externally-closed cases (a `thread.updated` patch alongside `thread.archived`), and mirror it in `next`.
- Archived-user threads that dropped off the snapshot: add a pass over `projection.threads` where `shelf === "archived" && archiveReason === "user" && paneAlive !== false && !livePanes.has(paneId)` (match terminalId the same way the live loop does via `threadKey`) → `patch(thread.id, { paneAlive: false })`. Apply the same two-look debounce as the "gone panes" block (`ctx.missingThreads`) unless `ctx.first`, to survive partial snapshots; note that choice in the commit message. The existing "gone panes" loop skips archived threads, so this is a separate pass. Add the thread ids to the `missingThreads` set it returns so the debounce state carries.
- Tests in `bridge/threads/herd-ingest.test.ts`: new thread has `paneAlive: true`; existing live thread backfilled to true; user-archived thread patches `paneAlive: false` when its pane leaves the snapshot (and only after the debounce); user-archived thread whose pane is still live gets no false patch; externally closed unarchived thread archives `pane-closed` with `paneAlive: false`.

## 3. Bridge effect — `thread.pane.close` in `bridge/threads/v2-routes.ts`

- `V2RoutesDeps` gets `herdr: Pick<HerdrClient, "closePane">` (optional or required to match how tests build deps); `bridge/server.ts` (line ~120, `createV2Routes({...})`) passes the existing `herdr`.
- Effect handlers receive `(command, ctx)` with no `req`, so no device-scoped audit. Choice: extend `EffectContext` (defined in v2-routes.ts) with an optional `audit: AuditLog`, filled by `runEffect` from `auditFor(req)`; the handler uses it. Alternatively build the handler inside `createV2Routes` as a closure over `runEffect`'s `req`. Pick whichever changes fewer call sites; keep `dispatch.ts`/`live-modes.ts` untouched.
- Register inside `createV2Routes` by merging into `effects` (`{ "thread.pane.close": closePaneEffect, ...deps.effects }` — deps.effects wins only if someone overrides it). Handler, in order:
  1. `store.getThread(command.threadId)`; absent → `{ ok:false, status:404, code:"not_found", error:"no-such-thread" }` (match the existing `EffectOutcome` failure shape and the `refuse(404, "not_found", "no-such-thread")` code used by `runPure`).
  2. `if (!paneAlive(thread))` → idempotent success: no herdr call. Still return `{ ok: true, sequence }` using the store's current sequence (see how other effects return a sequence for a no-op; if none exists, append a receipt-only commit via `store.append([], { commandId, receipt })` if the store allows, else a `thread.updated` `{ paneAlive: false }` patch only when the thread's `paneAlive` is not already false). Record the receipt so a retry replays.
  3. `await queue.run(paneKey(thread.paneId), () => herdr.closePane(thread.paneId))` (same `queue` and `paneKey` as `pane-write-routes.ts closePane`). `PaneBusyError` is already mapped to 503 `busy` by `execute`.
  4. Audit `{ action: "pane.close", paneId, detail: { threadId, via: "v2-command" } }`. Note `runEffect` already records a generic `v2-command` audit on success; keep both.
  5. Reconcile state: archived thread → `thread.updated` `{ patch: { paneAlive: false }, at }`; otherwise → `thread.archived` `{ reason: "pane-closed", at }` plus `paneAlive: false` patch, ending any open run as `interrupted` and expiring pending runtime requests. Reuse whatever `queue-drain.ts` (line ~415) / the run and request reducers already do on `thread.archived` — do not hand-roll; verify by grep that archiving via event already ends runs and expires requests, and if it only happens in the ingest path, emit the same events the ingest `archive()` helper emits. Append with `store.append(events, { commandId, receipt: { type: "thread.pane.close", result: { hash } } })`. Then `deps.herdIngestor?.reconcile(engine.current())`.
  6. Return `{ ok: true, sequence: last }`.
- `thread.delete` in `bridge/threads/decide.ts` keeps `if (state.paneAlive) return reject("conflict", "pane-open")` unchanged.
- Tests in `bridge/threads/v2-routes.test.ts` (mock `herdr.closePane`, mock audit): calls `closePane(paneId)` once and audits `pane.close`; active thread ends archived with `reason: "pane-closed"`, open run `interrupted`; archived thread patches `paneAlive: false` and stays archived; dead pane returns success without calling herdr; unknown thread 404; repeat `commandId` replays the receipt without a second herdr call.
- `bridge/threads/decide.test.ts`: only if you touch `decide.ts` (you should not).

## 4. web2 — wire the command

- `web2/src/lib/archived.ts`: add `closeArchivedPane(threadId)` using `sendCommand("thread.pane.close", { threadId }, commandDeps())`, returning an outcome in the style of `DeleteOutcome` (`closed` | `gone` | `refused`). Add `closeAndDeleteArchivedThread(threadId)` = close, then (if not refused) `deleteArchivedThread`; map a refused close to `{ kind: "refused", reason }`. Update `deleteRefusalText("pane-open")` only if wording needs to point at the new button (keep it as the fallback).
- Shared two-tap helper: reuse the existing confirm pattern in `archived.tsx` (line ~93, delete confirm / "Clear older than N days"). Do not add a new global; use a local `armed` state with a timeout like the existing code.

## 5. web2 UI

- `web2/src/routes/archived.tsx`: per row, beside timestamp/reason, `t.paneAlive` → pill `● Pane open in Herdr` (`bg-amber-500/10 text-amber-500`); otherwise muted `Pane closed`. Top summary line when any are open: `N archived thread(s) have open panes running in Herdr` (singular/plural; a filter toggle is optional — a summary counter satisfies the spec). For open panes show a **Close pane** button with two-tap: `Close pane?` → `Tap again to close`. **Smart delete**: the trash tap on a `paneAlive` row arms `Close pane & delete?`; second tap runs `closeAndDeleteArchivedThread`. Keep the existing refusal flow for other reasons.
- `web2/src/components/Sidebar.tsx` (settled shelf; row rendering is in `sidebar/SidebarThreadRow.tsx` via `ThreadStatusDot`): a settled thread with `paneAlive === false` renders its status ring as inactive/closed (muted dashed/dim ring, `title="Pane closed"`). Add the variant to `ThreadStatusIndicators` rather than branching in the row, if that component owns the ring.
- `web2/src/components/chat/ThreadDetailsPanel.tsx`: new `DetailRow label="Herdr Pane"` showing paneId, terminalId (omit when empty) and a dot + `Open / Running` (green) or `Closed` (gray); when open, `action` = inline **Close pane** button (two-tap, same wording). Sits after Status.
- `web2/src/components/CommandPalette.tsx` + `CommandPalette.logic.ts`: new command "Show threads with open Herdr panes" that narrows the thread list to `paneAlive === true` (including archived ones; the current thread list excludes archived at line ~105, so this filter must include them or navigate to `/archived` — pick the in-palette filter and note it). Never key on a harness id.
- `web2/src/components/sidebar/ThreadRowMenu.tsx` (Archive item at line ~92) and `web2/src/components/chat/ChatHeader.tsx`: add destructive **Close pane** item below Archive for non-archived threads whose `paneAlive !== false`. Two-tap: first tap relabels to `Tap again to close`, second runs `thread.pane.close` (menus close on action via the existing `run(...)`; implement the arm inside the menu so the first tap does not dismiss it). Item copy/tooltips: Archive keeps the pane running; Close pane terminates it and archives as pane-closed. Read-only devices: hide it like Archive.
- `web2/src/components/right-panel/TerminalPanel.tsx`: add an icon-only **Close pane** button in the mirror toolbar (lines ~270-320, next to the Keys button), `aria-label="Close pane"`, two-tap arm, hidden when `paneAlive === false` or read-only. It needs the thread; check how the panel is given its thread/paneId.
- Tests: `web2/src/lib/archived.test.tsx` (or a route test beside `routes/archived.tsx`) — "Pane open in Herdr" badge renders for `paneAlive: true`, "Pane closed" otherwise; Close pane two-tap sends `thread.pane.close`; smart delete sends `thread.pane.close` then `thread.delete`; refused close does not delete. New `web2/src/components/sidebar/ThreadRowMenu.test.tsx` — Close pane two-tap sends the command, hidden for archived threads. Add small cases to `ChatHeader.test.tsx`, `TerminalPanel.test.tsx`, `CommandPalette.logic.test.ts`, and a ThreadDetailsPanel assertion only if a test file for it already exists.

## 6. Docs

- CHANGELOG.md `## [Unreleased]` → `### Added`: one line — the v2 app shows whether a thread's Herdr pane is still open (Archived page, settled ring, thread details) and can close it (`thread.pane.close`: row menu, chat header, terminal, Archived with a two-tap, Delete closes the pane first).
- Optional: if a command list is documented in `docs/specs/t3/` or `docs/ARCHITECTURE.md`, add the command there. CONTEXT/DECISIONS/STATE untouched.

## Verify

- From the worktree root: `bun test` for `bridge/threads/contracts.test.ts bridge/threads/herd-ingest.test.ts bridge/threads/v2-routes.test.ts bridge/threads/decide.test.ts`; root typecheck (`bun run typecheck` or the script in package.json); web2 vitest for the touched files plus the web2 typecheck; `bun scripts/web2-harness-ids.ts` (no harness-id branching).
- `grep -rn "react\|@shared" ` the bridge-imported `web/src/lib/*` files is unaffected (this change does not touch `web/src`).
- No live herdr commands anywhere.

## Invariants to preserve (from spec)

1. `thread.pane.close` is structural only; sends no keystrokes.
2. Closure goes through `PaneQueue` (`queue.run(paneKey(paneId), …)`).
3. Closing an already-closed pane is an idempotent success.
4. `thread.delete` still enforces `!state.paneAlive`.
5. Every closure records an audit `pane.close`.
