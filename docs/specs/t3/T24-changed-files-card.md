# T24 — A changed-files card under each run's reply, from the journal

Status: built and merged 2026-10-19 (PR #103; diffs series, T24-T31). Build-time amendments are recorded in this file. Depends on: T11 (timeline rows), T13 (`openPrintedPath`, `useSheetHistory`). Plan: [`docs/T3_ADAPTATION.md`](../../T3_ADAPTATION.md); the series reverses its "per-turn diffs" line, rollback stays out. web2 only: no bridge, contract or migration change.

## Problem

"What did this run change?" is answered today by opening each edit row in the work log. A folded run (`Worked for 2m`) hides its edit rows, so after the run ends there is no overview at all. T3 puts a card under each turn's reply: files grouped in a tree, `+N -M` per file, tap to open the diff.

Sightr has the data without git: the journal gives each `file_change` item `{fileName, additions, deletions, diffStr, oldStr, newStr, errorText?, truncated?}` and a `runId` (`shared/v2/contracts.ts`; built in `bridge/journal/structured.ts`). This slice groups them by path per run. T30/T31 later upgrade the same card to exact git checkpoints.

## Change

### Summary: `web2/src/components/chat/ChangedFiles.logic.ts` (pattern; T3's `deriveThreadCheckpointSummaries` job)

`deriveRunChangedFiles(entries): Map<runId, RunChangedFiles>` over `file_change` items (`entry.projectedItem`, so folded work entries still count). Per run, per normalised path (`\` to `/`, no leading `./`; exact case, so `A.ts` and `a.ts` stay two rows; a relative and an absolute spelling of one file stay two rows):

- `additions`/`deletions`: sum over `completed` items. Edits to one file in one run add up, so the numbers are the sum of edits, not the net change (A to B then B to C reads +2 -2, net +1 -1). `countsKnown` is false when a completed item has no counts (journal built only `oldStr`/`newStr`); that row shows no `+/-`.
- `edits`, `itemIds` in item order. `created`: a completed item whose `diffStr` starts `--- /dev/null` (the bridge's new-file Write). Whether a Write over an existing file is marked as an update is verified at build.
- `failed`: items in `failed`/`cancelled`/`interrupted`, never summed; the row keeps a "failed" badge and the first `errorText` goes to the sheet. A path with only failed items still lists, so a failure survives a folded run. `running`: `pending`/`running` items; the path lists with a dot and no counts until they complete.
- `truncated`: any item with `truncated`. The bridge counts before it caps `diffStr` (24,000 chars), so counts stay whole; the sheet says the diff is cut.
- Totals (`additions`, `deletions`, `files`, `failedEdits`) and two caveat flags: `shellRan` (the run has a `command_execution` item) and `editedTwice` (files with `edits > 1`).
- Relation to `changedFiles`: `session-logic.ts:285` and `t3/client-runtime/work-log/presentation.ts:223` count distinct paths per work group for the header ("Edited 3 files"). They stay untouched (the second is a T3 adapted file). The card is the per-run, per-path source; the two agree except for path spelling.

### Row: `MessagesTimeline.logic.ts` and `MessagesTimeline.tsx`

- New row `{kind: "changed-files", id: "changed-files:<runId>", runId, summary}`, added in `deriveMessagesTimelineRows` after `attachTrailingToolGroupsToAssistant` and before the `continuesWorkLog` pass and day dividers. Anchor: the run's last assistant message row; if `assistant-meta:<messageId>` follows (trailing tool groups moved the meta) the card goes after it. A run with no assistant message anchors after its last work row, or its `turn-fold` row when everything is folded.
- Not part of a work-log group (`timelineRowIsWorkLog` stays false), so it never breaks `continuesWorkLog` and a folded run keeps its card while its work rows hide. `getItemType` already splits by `kind`. `useTimelineFollow.ts:27` does not list the kind, so a card appearing does not count as an unseen row. `isRowUnchanged` compares a signature of the summary (path, counts, status, edits, truncated), so a streaming run re-renders only its card.
- A run with no `file_change` items gets no row. A run with only failed edits gets one (header "No files changed").
- Running run: the same row, derived from live items, so counts and rows update as edits complete. Its anchor is the latest assistant message, so the card moves down when a newer message starts streaming; the row id is stable, so the list keeps its identity. Interrupted and failed runs keep their card.
- `data-thread-find-ignore` on the card. History paging: only loaded items count; whether a page boundary can cut a run is verified at build.

### Rendering (ledger below)

- `AssistantChangedFilesSection.tsx`: header "Changed files (N)" with the total `DiffStatLabel`, a tree/flat toggle, and "Collapse all"/"Expand all" (tree only). Auto view is tree when files span more than one directory and number 5 or more, else flat; the toggle overrides and is a per-device preference (`sightr:v2:changed-files-view`, try/catch `localStorage`). More than 50 files: first 50 and "Show all N". The caveat line "Counts add up each edit and miss changes made by shell commands." shows only when `shellRan` or `editedTwice`.
- `ChangedFilesTree.tsx` (adapted): rows call `onSelect(path)`, carry the created/failed/running marks, wrap paths (no truncation), `pointer-coarse:py-2.5` and a 44 px target on touch. Icons are lucide (a VS Code icon helper is used only if web2 already has one). `DiffStatLabel` is reused unchanged.
- Expand-all state: `state/timeline.ts` gains `collapsedChangedDirs: Record<runId, ReadonlySet<string>>` per thread (default empty, so the tree opens fully), `toggleChangedDir`, `setChangedDirsCollapsed`; in memory like the fold sets, so a row the list unmounts comes back as left.

### Tap-through

- A file row calls `openChangedFile({threadId, runId, path})` from `changedFilesTarget.ts`. This is the seam: today it opens `ChangedFileSheet`, one store-backed sheet mounted beside `ThreadDetailsSheet` (same pattern: `Sheet`/`SheetPopup`, bottom with `max-h-[85dvh]` on phone, right on desktop, `useSheetHistory` so Back closes it). T27 repoints this one function at the diff panel's run scope on desktop; nothing else in the card changes.
- The sheet lists the path's edits in order ("Edit 2 of 3", each with its status), each drawn by `FileChangeDetail`, extracted from the `file_change` branch of `ToolItemDetail.tsx:249-262` with no change to what it shows (Open-file link, `DiffStatLabel`, Copy diff, error, 200-line diff, Before/After fallback). A top "Open file" button calls `openPrintedPath` (opens Files; a refused path toasts as today). The sheet never lists a net diff: the journal cannot make one when a file is edited twice, and it says so when `edits > 1`.
- Unmounted when closed. Nothing is fetched: it reads the items from the thread store by id.

### Ledger rows (`web2/t3-upstream.json`, upstream at T3 `3a4d118a518a`, full sha taken from the cache at build)

| local | upstream | mode |
|---|---|---|
| `src/lib/turnDiffTree.ts` | `apps/web/src/lib/turnDiffTree.ts` | verbatim if its imports resolve (its input type through `src/t3/shims`), else adapted with the header line |
| `src/lib/turnDiffTree.test.ts` | `apps/web/src/lib/turnDiffTree.test.ts` | same mode as the source |
| `src/components/chat/ChangedFilesTree.tsx` | `apps/web/src/components/chat/ChangedFilesTree.tsx` | adapted (header names path + commit) |
| `src/components/chat/AssistantChangedFilesSection.tsx` | `apps/web/src/components/chat/MessagesTimeline.tsx` (section inside it) | pattern |
| `src/components/chat/ChangedFiles.logic.ts` | `packages/client-runtime/src/state/threadCheckpoints.ts` | pattern |

`DiffStatLabel.tsx` keeps its verbatim row at `db5919d87`. The `MessagesTimeline*` and `ToolItemDetail.tsx` rows keep their commits (local edits, no sync). The `DiffPanel.tsx` skip decision stays until T27.

## Not in this slice

Rollback, restore, checkpoints and git capture (T30); exact per-run diffs (T31); the diff panel and its run scope (T27); a renderer change (T25); split view; line comments; any bridge route. Hidden or secret paths are not filtered: the card only shows paths the agent already printed in this thread.

## Invariants

- Read-only: no write, no network call, no bridge call; nothing runs git.
- web2 never branches on harness id: the card reads item types only, so a harness whose journal writes no `file_change` shows no card.
- The journal misses edits made through shell commands (formatters, `sed`, `git checkout`, builds, moves) and edits outside the thread's runs, and cannot show a net diff for a file edited twice. The card is "what the agent's edit tools did", and the caveat line says so. Counts can differ from the Git tab, which shows the working tree against HEAD.
- Deriving the summary and the row is O(entries) per timeline derive; diff bodies stay out of rows.

## Tests

- `web2/src/lib/turnDiffTree.test.ts`: T3's cases ported (grouping by directory, single-child directory compaction, stat roll-up, sort order, empty input); run unchanged against the file.
- `web2/src/components/chat/ChangedFiles.logic.test.ts`: two edits to one path sum; a failed item is excluded and listed with its error; a running item lists with no counts; a missing-counts item sets `countsKnown` false; a `--- /dev/null` diff sets `created`; `truncated` propagates; `\` and `./` normalise; `shellRan` and `editedTwice` set; no `file_change` yields no entry.
- `web2/src/components/chat/MessagesTimeline.logic.test.ts` (extend): the card follows the last assistant message, follows `assistant-meta` when trailing tool groups moved it, stays when the run is folded, is absent for a run without edits, anchors after the last work row for a run with no reply, keeps its id while a running run's counts change, and `isRowUnchanged` ignores an unrelated item change.
- `web2/src/components/chat/ChangedFilesTree.test.tsx`: tree and flat rows, marks, select callback, collapse-all and expand-all, long path wraps.
- `web2/src/components/chat/AssistantChangedFilesSection.test.tsx`: header totals, auto view rule and per-device override, 50-file cap, caveat line only with `shellRan` or `editedTwice`, tapping a row calls the seam.
- `web2/src/components/chat/ChangedFileSheet.test.tsx`: edits in order with "Edit n of m", failed edit shows its error, Open file calls `openPrintedPath`, Back closes it. `StructuredItems.test.tsx` and `MessagesTimeline.test.tsx` pass unchanged (the `FileChangeDetail` extraction).
- `web2/src/state/timeline.test.ts` (new): collapsed-directory sets per run and thread.
- Live check, scratch herdr workspace, `ca` at 390 px: a Claude run that creates one file and edits another twice; the card sits under the reply with correct counts and a "new" mark; a tap opens the bottom sheet with two edits; Back closes it; Open file lands in the Files sheet; mid-run the card appears and updates; after the fold the card remains. Touch targets, `pointer-coarse` and the iOS inset are not verified without a real phone.

## Open questions

- Should the card sit above the reply text rather than under it for a very long reply? Assumed under, as T3 does.
- Does a page of "Load earlier messages" ever cut a run in half (a partial card)? Verified at build; if so, mark the card "from loaded messages".
- Who adds the T24-T31 rows to `docs/specs/t3/README.md` and rewords the "per-turn diffs" never-take line in `docs/T3_ADAPTATION.md`? Assumed one series docs PR, not this slice's build.
