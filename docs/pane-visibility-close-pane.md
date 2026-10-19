# Pane visibility and Close pane (v2, issue #112)

Sightr v2 now shows whether a thread's Herdr pane is still open, and can close it. Before, v2 had no way to close a pane, so an archived thread could not be deleted (`thread.delete` refuses with `pane-open`) without going to v1 or Herdr.

## Data model

- `Thread.paneAlive?: boolean` and the same field on `ThreadPatch` (`shared/v2/contracts.ts`). `true` means Herdr's snapshot lists the pane. `false` or absent means it does not.
- New command `thread.pane.close { threadId }`, added to `Command` and `COMMAND_TYPES`. It is structural and sends no keystrokes.
- `bridge/threads/store.ts`: migration 8 adds a nullable `threads.pane_alive` column (1 / 0 / NULL = not said yet).

## Bridge

**Ingest (`bridge/threads/herd-ingest.ts`, `diffHerd`)**
- New and live threads get `paneAlive: true`.
- A thread archived by ingest (any reason except `user`) is patched `paneAlive: false`.
- A user-archived thread keeps `paneAlive: true` while its pane is listed. When Herdr stops listing it, ingest patches `paneAlive: false`. If a user-archived thread's pane is still listed, it is patched back to `true` rather than revived.

**Command (`bridge/threads/v2-routes.ts`, `closePaneEffect`)**
- `bridge/server.ts` now passes `herdr` into the v2 routes. Without it, the command answers 501 `unsupported`.
- Unknown thread: 404 `no-such-thread`.
- Pane already not alive: success, no Herdr call, receipt recorded (idempotent).
- Otherwise, on the pane's `PaneQueue` turn: `herdr.closePane(paneId)`, then an audit entry `pane.close` with `detail: { threadId, via: "v2-command" }`.
- Archived thread: emits `thread.updated { paneAlive: false }`.
- Active, pinned or settled thread: ends open runs as `interrupted`, expires pending requests, then emits `thread.archived { reason: "pane-closed" }` and `thread.updated { paneAlive: false }`.
- Then `herdIngestor.reconcile()` runs and the reply is `{ ok: true, sequence }`.

## UI (`web2/src`)

- `hooks/useClosePane.ts` (new): two-tap confirm (first tap arms, second sends `thread.pane.close` and toasts). It uses `closeThreadPane` and `paneOpenThreads` from `lib/archived.ts`.
- `routes/archived.tsx`: each row shows a `● Pane open in Herdr` pill or "Pane closed". A summary line appears at the top when archived threads have open panes. Rows with an open pane get a two-tap "Close pane" button. The trash button on such a row arms as "Close pane & delete?", then closes the pane and deletes. If the bridge still answers `pane-open`, delete retries up to 4 times, 600 ms apart.
- `components/sidebar/ThreadRowMenu.tsx`: "Close pane" item, shown when `paneAlive === true`. The first tap arms and keeps the menu open. Archive still leaves the pane running.
- `components/chat/ThreadDetailsPanel.tsx`: "Herdr pane" row with pane id, terminal id, an Open / Running or Closed indicator, and an inline Close pane button when open.
- `components/right-panel/TerminalPanel.tsx`: power-icon Close pane button in the mirror toolbar (not in read-only mode, only when the pane is open).
- `components/ThreadStatusIndicators.tsx` and `sidebar/SidebarThreadRow.tsx`: `ThreadStatusDot` takes `paneClosed`. A settled thread with `paneAlive === false` renders a dashed, faded ring labelled "Pane closed".
- `components/CommandPalette.tsx` and `CommandPalette.logic.ts`: command "Show threads with open Herdr panes" switches the palette to a filtered list (`buildOpenPaneItems`, archived threads included, newest first). Backspace on an empty query goes back.

## Not in the diff

`ChatHeader.tsx` is not in the diff, so the spec's "Close pane" in the chat header was not implemented in this change. The thread menu, details sheet and Terminal tab cover closing from an open thread.

## Verify

Tests added or extended (mocks only, no live Herdr):
- `bridge/threads/contracts.test.ts`: `thread.pane.close` is a valid command type.
- `bridge/threads/herd-ingest.test.ts`: `paneAlive` set on create and live threads, and cleared for user-archived threads when the pane drops.
- `bridge/threads/v2-routes.test.ts`: closes an active thread (archived `pane-closed`), patches an archived thread, and is idempotent for a dead pane without calling Herdr. Also covers the `closePane` call and the audit entry.
- `bridge/threads/spawn.test.ts`: one-line update.
- `web2/src/lib/archived.test.tsx`, `components/sidebar/ThreadRowMenu.test.tsx`, `components/ThreadStatusIndicators.test.tsx`, `components/CommandPalette.logic.test.ts`, `components/CommandPalette.messages.test.tsx`.

By hand: archive a thread, open `/archived`, and check the amber pill and the summary line. Tap Close pane twice and the pill should change to "Pane closed". Tap the trash icon on a thread with an open pane and it should read "Close pane & delete?".

The change is also noted under Unreleased in `CHANGELOG.md`.
