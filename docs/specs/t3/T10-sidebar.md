# T10 — Sidebar: projects, threads, shelves

Status: done on feat/v2-web (2026-10-16). Depends on: T09 (shell, stores, `sendCommand`), T02 (projects and threads), T05 (commands). Read `README.md` in this folder first.

## Problem

v1 shows a spaces tree and a triage list (`web/src/components/space-tree.tsx`, `lib/triage.ts`). Both are derived in the browser from a polled snapshot, and
"seen" is the only shared state. v2 needs T3's thread sidebar: threads under projects, status at a glance, and shelves the operator controls
(pin, snooze, settle, archive) that look the same on the phone and the desktop.

T3 reference (read for behaviour, take patterns only; MIT, note the source in a code comment if any logic is adapted):
T3: `apps/web/src/components/Sidebar.tsx`, `Sidebar.logic.ts`, `Sidebar.snooze.ts`, `ThreadStatusIndicators.tsx`, `docs/user/thread-sidebar.md`.

## Change

All in `web2/src/components/sidebar/` and `web2/src/state/sidebar.ts`, filling the Sidebar slot from T09.

### Projects and threads

- A **project** row is a herdr workspace (`project.label`, number). Worktree workspaces (`worktreeOf`) nest under their primary checkout's row with a branch
  glyph and the worktree name; a lone worktree whose primary is missing shows at top level.
- Projects follow `project.order` from the shell snapshot. A project collapses; the state is a per-device preference in `localStorage` (wrapped in try/catch).
- A **thread** row: `AgentIcon` for the harness (copy `web/src/components/agent-icon.tsx` and `agent-icon-data.ts`; brand data comes from `shared/agents.ts`), title,
  status dot, relative last-activity time (Consolas), and an unread mark.
- A project row shows one **roll-up dot**: the worst status among its non-archived threads, in the order `approval · input · failed · working · done(unread) · idle`.
  The rank lives in `shared/v2/contracts.ts`; import it, do not redeclare.
- Rows are keyboard focusable; Up/Down move focus, Enter opens, `Space` opens the row menu.

### Status dots

- One `ThreadStatusDot` component. Colours come from tokens: `approval` and `input` use accent (the "you" step), `failed` warn, `working` navy, `done` ok,
  `idle` a hollow muted ring, `starting` (T07, a spawn in flight) a hollow navy ring with the working pulse. Only `approval`, `input` and `done` are solid with the "needs you" weight; idle is quiet so eighteen of them do not shout.
- `working` pulses (opacity only, 1.2 s, `prefers-reduced-motion` stops it) and the row shows elapsed time since the run started, ticking each second,
  formatted with `elapsed()` from `@v1/lib/thinking-pulse`. This is the product's one motion; nothing else animates.
- Every dot has an accessible name ("Needs approval", "Working, 2m 14s", "Idle", "Starting").

### Shelves

Order inside a project (or flat, see below): **Pinned**, **Active**, **Snoozed**, **Settled**. Archived threads are not in the sidebar; a footer link opens `/archived`.

- Pinned sorts by `pinOrder`. Active sorts by status rank, then `lastActivityAt` descending. Snoozed and Settled are collapsed sections with counts.
- A snoozed thread whose `snoozeUntil` passes returns to Active by a bridge event (T01), not by a client timer; the client only renders `shelf`.
- **Every shelf change is a bridge command**, shared across devices: `thread.pin|unpin`, `thread.snooze {until}`, `thread.settle|unsettle`, `thread.archive|unarchive`,
  `thread.markRead|markUnread`, `thread.rename`. The UI applies the change optimistically in the `useShell` store keyed by `commandId`, and rolls it back if the command
  fails or the shell stream contradicts it. Nothing about shelves is kept in `localStorage`.
- **Row menu** (long press on touch, right click or `Space` on desktop): Rename, Pin/Unpin, Mark unread/read, Snooze…, Settle/Unsettle, Archive.
  Snooze offers 1 h, 3 h, tomorrow 08:00 and Pick time (a native `datetime-local`).
- **Rename** is inline; Enter sends `thread.rename`, Escape cancels, empty is refused.
- **Mark unread** sets `unreadDone` true; opening the thread sends `thread.markRead` once the thread stream is `synchronized`, not before.
- **Undo toasts.** Unpin, settle, snooze and archive show a toast for 5 s with Undo: "Settled · Undo". Undo sends the inverse command with the previous
  `shelf`, `pinOrder` and `snoozeUntil` captured at click time. The toast stack (`web2/src/components/toast.tsx`) holds one undo at a time; a new one replaces the old.
  `mod+z` runs the latest undo when no text field is focused (registered through T13's keybinding table; until T13 lands, the sidebar registers it itself).
- **Desktop drag.** Pointer-based drag with a keyboard alternative (the row menu). Drop targets and their action: into Pinned pins at the drop index; from Pinned into Active unpins;
  onto the Settled header settles; from Settled into Active unsettles; from Snoozed into Active wakes. Dropping onto Snoozed is refused, because snoozing needs a time; the
  header shakes once and a toast says "Pick a snooze time from the menu". While dragging, section labels show and the section under the pointer takes the accent border. Reorder within a section sends `thread.pin` with the new index.
- **Phone swipe.** Swipe right on a row reveals Pin; swipe left reveals Settle and Archive. A full swipe runs the first action. Use the pointer-event approach of
  `web/src/hooks/use-swipe.ts`, with a vertical-scroll guard (abort when `|dy| > |dx|` in the first 10 px). Swipe actions use the same commands and undo toasts.

### Filter: needs you

- A chip row above the list: **All** and **Needs you**. Needs you shows threads whose status is `approval`, `input`, `failed`, or `done` with `unreadDone`, across all projects and shelves except Settled
  and Archived, flat and sorted by status rank. The count appears on the chip and in `document.title` as `(n) Sightr` on desktop, as v1 does (`web/src/routes/root.tsx`). The filter choice is a per-device preference.
- A search box filters by title, project label and harness (substring, case-insensitive). While it has text, shelves collapse into one flat list.

### Archived route

- `/archived`: threads with `shelf: "archived"`, newest `archivedAt` first, read-only (open shows the timeline from T11 with the composer replaced by "This thread's pane was closed").
  Actions: Unarchive (only when its pane still exists), nothing else. Paged client-side, 50 at a time.

## Invariants

- The sidebar renders only from the `useShell` store; it never calls v1 endpoints.
- Shelf state is bridge state. Reloading or opening a second device shows the same shelves.
- A thread in `approval` or `input` is never hidden by a collapsed section: the project row and the section header show the roll-up dot.
- The roll-up order matches `shared/v2/contracts.ts` exactly.
- Undo restores the previous shelf and position, not just the opposite flag.

## Tests

- **Logic** (`sidebar.logic.test.ts`): shelf partition and sort; roll-up picks the worst; worktree nesting and orphan worktree; needs-you filter membership; search flattening.
- **Dot:** each status renders its token class and accessible name; working shows elapsed and ticks (fake timers); reduced motion removes the pulse.
- **Commands** (msw on `/api/v2/command`): pin, snooze, settle, archive, rename, mark unread each post the right `type` and a unique `commandId`; a 500 rolls back the optimistic change;
  a shell event for another device's change updates the list.
- **Undo:** the toast lasts 5 s (fake timers), Undo posts the inverse with the captured position, a second toast replaces the first, `mod+z` is ignored inside a textarea.
- **Drag:** each of the five drops posts the expected command; drop on Snoozed posts nothing and shows the toast.
- **Swipe:** a horizontal swipe reveals actions; a vertical scroll does not; a full swipe runs Pin.
- **Rename:** Enter commits, Escape cancels, empty is refused.
- **Mark read:** opening a thread does not post `markRead` until `synchronized`.
- **Archived route:** lists archived threads; the composer is replaced; Unarchive shows only when the pane exists.
- **a11y:** arrow-key focus movement and Enter open; the menu opens with `Space`.

## Built

Built on `feat/v2-web` before T05, against msw and the fake `EventSource` with the shapes in `shared/v2/contracts.ts` and
`web2/src/stream/wire.ts`. Every shelf change goes through T09's command client.

- **Files mirror T3's names.** `components/Sidebar.tsx` (pattern), `Sidebar.logic.ts` (adapted: section model, drop verbs,
  `planPinnedReorder` on numbers, row accessibility, adjacent-row traversal), `Sidebar.snooze.ts` (adapted from
  `Sidebar.snooze.ts` + client-runtime `threadSettled.ts`), `Sidebar.drag.ts` (pattern, @dnd-kit), `ThreadStatusIndicators.tsx`
  (`ThreadStatusDot`), `CustomSnoozeDialog.tsx`, `components/sidebar/SidebarThreadUndoNotice.tsx` + `hooks/showThreadUndoNotice.ts`
  (adapted), plus `sidebar/SidebarThreadRow.tsx`, `sidebar/ThreadRowMenu.tsx`, `components/toast.tsx`, `state/sidebar.ts`,
  `hooks/useSwipeActions.ts`, `lib/archived.ts`, `components/AgentIcon.tsx` (v1's icon and data in one file). All T3 rows are in
  `web2/t3-upstream.json`; a config test checks every adapted file's header names its upstream. No shims were needed: the
  adapted bodies had their Effect / client-runtime imports replaced by plain code. @dnd-kit pinned to T3's lockfile:
  core 6.3.1, sortable 10.0.0, modifiers 9.0.0, utilities 3.2.2.
- **Contract additions (bridge + shared).** `thread.pin` takes an optional `pinOrder` (a drop index, an undo; a pinned thread
  with a different order moves, T3's `thread.pin.reorder`). New `thread.unsnooze` (T3's name) wakes a snoozed thread: the
  Snoozed → Active drop and the undo of a snooze need it, and no command could do it. `decide.ts` handles both.
- **`Project.repoKey`.** T02 sets `worktreeOf` to herdr's repo key, which the client could not match to a primary checkout. The
  herd ingest now sets `repoKey` on every workspace with git info; store migration 2 adds `projects.repo_key`. A worktree nests
  under the open project with the same `repoKey` and no `worktreeOf`; otherwise it stands at top level.
- **Optimistic changes** live in a small store beside `useShell` (`usePendingShelf`, keyed by `commandId`), not inside it.
  The sidebar draws `useShell` threads with pending commands applied (`applyShelfCommand` mirrors `decide.ts`). An entry goes
  when the command fails (rollback plus an error toast) or when the shell stream reaches the reply's sequence (the stream is
  then the truth; 15 s cap). `stream/commands.ts` exports `defaultCommandDeps` so the caller can know the `commandId`.
- **Status.** The sidebar reads `unreadDone` into the status (read `done` shows idle, a marked-unread idle shows done), so
  mark read/unread shows at once. The project roll-up covers all non-archived threads and the nested worktrees (the bridge's
  `Project.status` covers only Active and Pinned). Snoozed/Settled headers show a dot only for approval, input, failed, done.
- **Working time.** The shell carries no run start, so the client notes when it first sees a thread go `working` (its
  `updatedAt` then); a thread already working at page load counts from its last update. T05 could add the run start to the
  shell snapshot. The time uses v1's `elapsed()` (`m:ss`), so the dot reads "Working, 2:14".
- **Snooze menu** offers T3's presets (1 h, 3 h, this evening, tomorrow 08:00, next week) plus Pick time and, on a snoozed
  thread, Wake now. A superset of the spec's list. The menu is flat (no submenu) for the phone.
- **Unarchive** shows when `archiveReason` is `user`, the one reason that leaves the pane open; the client has no pane list. A
  user-archived thread whose pane closed later is refused by the bridge and the toast says so. An archived thread's screen
  says "This thread's pane was closed." or, for a user archive, "This thread is archived." with Unarchive.
- **Undo** is one notice at a time (T3 groups same-action undos). Undo of an archive is `thread.unarchive` then the command to
  the old shelf.
- **Drag tests** drive the drop handler (`handleSidebarDrop`) with the store, not pointer events; @dnd-kit's pointer sensing
  does not run in jsdom. Drag is desktop only, with no keyboard sensor (Space opens the menu).
- **Swipe** right reveals Pin (Unpin on a pinned thread); left reveals Settle and Archive; a full swipe runs Pin/Unpin or Settle.

