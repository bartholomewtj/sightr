# T31 — Checkpoint UI: the card and the panel's run scope read checkpoints, fall back to the journal

Status: draft (diffs series). Depends on: T24 (changed-files card, journal-derived), T27 (diff panel, run scope from the journal), T30 (git checkpoints; bridge + shared, and the `scope=run` diff route, T26 shape). Plan: [`docs/T3_ADAPTATION.md`](../../T3_ADAPTATION.md). Web2 only: no bridge or `shared/` change.

## Problem

T24's card and T27's run scope are built from the run's `file_change` items (`shared/v2/contracts.ts:342`). That is "what the agent's edit tools reported": it misses edits made through the shell (`sed`, a formatter, `git checkout`, a build step), it lists a file the agent later reverted, and it sums every edit rather than showing the net diff. T30 stores a hidden-ref snapshot at run start and end, so a run's diff can be exact. This slice makes the UI use it when it exists and keep working when it does not. Rollback is not here: T3's `onRollbackCheckpoint` is never taken (README "Not in this series").

## Contract (from T30)

- **`Run.checkpoint?: RunCheckpoint`** `{ runId, threadId, appRunOrdinal, status: "pending" | "ready" | "absent", reason?, files: CheckpointFile[], additions, deletions, capturedAt?, truncated?, hidden?, skipped?, approximate?, shared?, unsettled? }`; `CheckpointFile { path, kind: "added" | "modified" | "deleted", additions, deletions, binary?, authored? }`. The file list is on the run, so the card needs no fetch.
- **Absent reasons:** `disabled`, `no-repo`, `start-missed`, `end-missed`, `too-large`, `timeout`, `git-failed`, `sparse-checkout` (T30 safety re-review: a sparse checkout with a folder outside its cone on disk, or an index Sightr could not read as it is).
- **`live?: boolean`** on the checkpoint: the snapshot objects still exist in the bridge's private store. Retention flips it to false (event `checkpoint.expired {runId}`), and the client updates without a refetch. The status stays `ready`, the file list stays, and the per-file patches captured at run end stay in the bridge's database.
- **Events and items:** `checkpoint.captured {checkpoint, phase}` updates `Run.checkpoint`; the `checkpoint` item (T3's item type: `checkpointId`, `files`, plus the whole `checkpoint`; id `checkpoint:<runId>`) is T3's timeline row. Sightr's card is T24's, so the timeline draws no row for it: T30 already filters it out of `deriveTimelineEntries` (`session-logic.ts`).
- **Patch route** (T30, filling T26's 501 stub): T26's `GET /api/files/git/review/patch?scope=run&threadId&runId&file&w`, with no `path`: the bridge finds the repo from the checkpoint, so archived threads work. `w=0` serves the stored patch for as long as the run's rows exist. `w=1` and the whole-file contents route (`scope=run`, for T28's expand) need live objects and answer `{available:false, reason:"expired"}` after expiry. Per-file patches only; the list is never fetched.
- **Project setting:** `Project.checkpoints?: boolean`, command `project.checkpoints.set {projectId, enabled}`.
- **Not provided by T30, so out of this slice:** an "All runs in this thread" range and a live "changes so far" view. There is no control for them.

## Change

All in `web2/src/`. Nothing here branches on harness id.

- **`t3/client-runtime/state/threadCheckpoints.ts`** (`pattern`, T3 `packages/client-runtime/src/state/threadCheckpoints.ts`, `deriveThreadCheckpointSummaries`, at the ledger baseline when built; surveyed at `3a4d118a518a`). T3 folds checkpoint projections into one summary per turn, newest last. Port the idea as `deriveRunCheckpointSummaries(runs, checkpointByRun): Map<runId, RunCheckpointSummary>`: plain functions, no Effect, ordered by `Run.ordinal`, a run with no checkpoint absent from the map. Ledger row mode `pattern`; the file carries a header naming the upstream path.
- **`lib/runChanges.ts`** (Sightr code): `resolveRunChanges({run, checkpoint, journalFiles})` returns the one thing both surfaces render: `{source: "checkpoint" | "journal", state, files, revertedCount, truncated, reason?}`. `journalFiles` comes from T24's grouping function (verify its name at build). The precedence table is in "Fallback matrix".
- **`components/right-panel/checkpointDiffState.ts`**: types for the panel, `CheckpointDiffState = loading | running | ready{source, files, truncated} | unavailable{reason}`, and a reducer-free mapper from `resolveRunChanges` plus the fetch result.
- **Card** (T24's component under `components/chat/`, `AssistantChangedFilesSection`/`ChangedFilesTree` adapted there; this slice edits it, adds no new ledger row for them). Header line carries a source badge in `ChangedFilesSourceBadge.tsx`: checkpoint shows "Exact"; journal shows "From agent edits". Badge is a button (44 px target under `pointer-coarse`) opening `ChangedFilesSourceSheet.tsx`: `ui/sheet.tsx` below 1024 px with a `history.pushState` entry so Back closes it (T13 rule), `ui/popover.tsx` above. Copy, two short paragraphs: "Exact: compared with a snapshot of the folder when the run started and when it ended. Includes changes made by shell commands and drops edits the agent undid." / "From agent edits: what the agent's edit tools reported. Shell-made changes are missing, a file the agent later reverted may still be listed, and several edits to one file add up." Plus a line giving the reason when it is a fallback.
- **Panel run scope** (T27's panel): `lib/api.ts` gains `fetchRunDiff(runId, opts, signal)` beside `fetchFolderGitDiff` (line ~338) for `scope=run`. Run picker `components/right-panel/RunPicker.tsx`: previous / next buttons and a label "Run 4 of 7 · 12:41", over runs that have changes or a checkpoint, default the latest run or the run the card opened. Concurrency 4 for lazy patches stays T27's. The scope header shows the same source badge and sheet.
- **Tap-through**: card row to panel uses T24/T27's open request (the `FileOpenRequest` pattern in `rightPanelStore.ts:39`), now carrying `runId` and `path`; the panel switches to run scope, selects that run, and reveals the file (scrolls it into view, expanded). On phone the Git sheet opens with the Back entry per `RightPanelSheet.tsx`.
- **Learning of a checkpoint**: `useThread(threadId)` (`stream/stores.ts:27`) already updates on run events; the card and picker read the derived map, so a checkpoint arriving flips a run's source without a refetch of the thread.
- **Ledger**: `web2/t3-upstream.json` row for `threadCheckpoints.ts` (`pattern`). The `DiffPanel.tsx` skip decision is reversed by T27; here only add a `note` that the per-turn scope is taken as read-only run scope.
- **Per-project toggle**: one row in `routes/settings.tsx` using `ui/switch.tsx`, "Take run snapshots in <project>", writing `project.checkpoints.set`. The line under it says what changes: exact run diffs, kept in a private copy under Sightr's own folder; nothing is written into your repository. Off affects later runs only; existing checkpoints stay until retention removes them. Read-only devices see it disabled. When `SIGHTR_CHECKPOINTS=0` the bridge reports every run `absent: disabled`; the row shows "Off for this bridge" and is disabled.
- **Flags on a `ready` checkpoint:** `shared` adds a footer "Another thread was working in this folder, so its edits may be included." `approximate` adds "Start snapshot was taken late; earlier edits may be missing." `unsettled` adds "Files were still changing when the snapshot was taken." `hidden` and `skipped` show as "N files not shown" (refused names and files the snapshot could not read).

## Fallback matrix

| Run state | Card and panel show | Badge |
|---|---|---|
| Checkpoint `ready`, has files | Checkpoint files and counts | Exact |
| `ready`, empty net diff | "No net changes." If the journal listed files: "The agent edited N files; the folder ended as it started." The card stays (never hidden) | Exact |
| `ready`, journal lists a path the checkpoint omits (reverted) | Checkpoint list only. Footer "N edited and reverted" opens the names, dimmed, no counts | Exact |
| `ready`, path in checkpoint but not in the journal (`authored: false`) | Listed with a small "shell" tag (no edit tool reported it) | Exact |
| `ready`, `live: false` (objects removed by retention) | List, counts and stored patches as usual. The Ignore-whitespace and Expand-context controls (T28) are disabled with "No longer available for this run" | Exact |
| `ready`, `truncated` | Files and counts given, footer "Showing M of N files"; a file with no patch does not expand (T27 behaviour) | Exact |
| `pending` or run `running` | Journal summary, labelled "Run in progress" | From agent edits |
| Run ended, checkpoint still `pending` | As above for up to 10 s ("Finishing snapshot"), then journal | From agent edits |
| `absent` (any reason), or no checkpoint (run predates T30) | Journal summary; sheet gives the reason in words (`disabled` "Snapshots are off for this project", `no-repo` "This folder isn't a git repository", `start-missed` "Sightr wasn't watching when the run started", `end-missed`, `too-large` "The folder is too large to snapshot", `timeout`, `git-failed`, `sparse-checkout` "A folder outside this repo's sparse checkout is on disk") | From agent edits |
| No checkpoint and no journal items | Card absent; panel run scope says "No recorded changes for this run." | none |

A failed `scope=run` fetch for a `ready` run falls back to the journal with a one-line "Couldn't load the exact diff" and a Retry; it never blanks the panel.

## Live and archived behaviour

- **While a run works** (end snapshot not taken): the panel's run scope shows the journal files with a strip "Run in progress. The exact diff appears when it ends." On `run.ended` the panel refetches (T27's run-ended hook; extract `useRunEnded` from `GitPanel.tsx:51` to a shared file if T27 left it local). There is no "changes so far" view.
- **Source flips** (journal to checkpoint when `checkpoint.captured` end arrives) keep expanded files and scroll by path; the badge changes and nothing else moves.
- **Archived threads** work like live ones: the card reads `Run.checkpoint`, and the route is keyed by thread and run, not by a pane, so stored patches load after the pane is gone. Only the `live: false` limits above apply. A run pruned with its thread (90 days) is gone from the stream, so there is nothing to show.

## Invariants

- "Exact" is shown only for a `ready` checkpoint whose data the client actually loaded. Everything else is labelled "From agent edits".
- The journal path from T24/T27 keeps working with no checkpoint field at all (older bridge, toggle off): all T31 behaviour is additive.
- Read-only: no rollback, restore, revert or stage control anywhere; the only write is the optional project toggle.
- Checkpoint and journal totals are never summed or merged into one count.
- Phone first: badge, sheet, picker and tap-through all work at 390 px with 44 px targets; a desktop-only hover is not the only route to the explanation.

## Tests

- `t3/client-runtime/state/threadCheckpoints.test.ts`: fixtures for no checkpoints, one, several out of order, a run with `pending` then `ready`, a removed (`gone`) run; order by `ordinal`.
- `lib/runChanges.test.ts`: every row of the fallback matrix as a fixture, including reverted, shell-made, empty net, truncated, running, finishing-timeout, and neither source.
- `components/chat/ChangedFilesCard.source.test.tsx`: badge text per source, sheet opens and closes, Back closes it, the reverted footer, the empty-net line, and a source flip keeping expanded rows.
- `components/right-panel/RunDiffPanel.test.tsx` (msw fake bridge serving `scope=run`): run picker previous/next, default run, tap-through from the card reveals the file, running strip then refetch on `run.ended`, `scope=run` failure falls back with Retry, `checkpoint.expired` flipping `live` (whitespace and expand disabled, stored patches still load), an archived thread loading a stored patch, the `shared`/`approximate`/`unsettled` footers.
- `routes/-settings.test.tsx` (the `-` prefix keeps the router from reading it as a route): the toggle writes `project.checkpoints.set`, read-only disables it, `SIGHTR_CHECKPOINTS=0` shows "Off for this bridge".
- Live, at 390 px in a scratch herdr workspace (`ca`, scratch bridge): a run that edits through `sed` (shows the shell tag), a run that edits then reverts, a run with no net change, a run in progress then ending, a project with snapshots off. Check badge, sheet, Back, picker, and reveal from the card.

## Amended at build

- **Matrix row 2.** A `ready` run with no net change and no journal edit draws no card (every chat-only run would get one). The "No net changes." card stays when the journal listed files, and reads "The agent edited N files; the folder ended as it started." The panel's run scope says the same for such a run.
- **"Off for this bridge" is inferred.** `SIGHTR_CHECKPOINTS=0` is on no wire shape (T30 keeps it out of `Project.checkpoints`), so the Settings row shows it when the open thread's newest run is `absent: disabled` while its project switch is on. A thread that is not open says nothing, and a run begun before the operator re-enabled a project can read `disabled` for a moment (the lag after re-enabling), which is why only the newest run counts.
- **Truncated footer.** The contract has no total file count, so "Showing M of N files" reads "Showing the first M files. The counts include every file."
- **Reverted names are repo-relative.** An absolute journal path is shown without the repo root learned from an edit that matches a listed file, else as its last two segments; no absolute path renders.
- **A failed exact read with an empty journal** still shows "Couldn't load the exact diff." with Retry and the "From agent edits" badge, over the checkpoint's list, so each file can retry. "Exact" shows only while the data loaded.
- **Stream.** `checkpoint.captured` and `checkpoint.expired` update `Run.checkpoint` in `stream/apply.ts` (they were ignored as unknown events); a `start` phase after the run's checkpoint is `ready` or `absent` is ignored.
- **Settings test path** is `routes/-settings.test.tsx`.

## Open questions

- The Exact badge, the "shell" tag and the per-project row rely on T30 shipping `authored` and `Project.checkpoints`; both are in T30 as drafted.
