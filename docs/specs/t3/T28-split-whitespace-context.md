# T28 — Diff panel: split view, ignore whitespace, expand unchanged lines

Status: draft (diffs series). Depends on: T25 (the `DiffCodeView` seam and the renderer decision), T26 (`ignoreWhitespace` on the file list and per-file patch routes; the whole-file contents route), T27 (the diff panel and its lazy per-file patch cache). Plan: [`docs/T3_ADAPTATION.md`](../../T3_ADAPTATION.md). Web2 only.

## Problem

T27's panel shows stacked, whitespace-sensitive hunks with three lines of context. Three reading aids are missing, each in T3's panel (`DiffPanel.tsx` header: stacked/split, ignore whitespace; `lib/diffFileContents.ts` for expansion):

- **Split view** reads a modified block (old left, new right) far better on a wide screen. It is useless on a phone, so it must never reach one.
- **Ignore whitespace** removes reindent and EOL noise, the usual reason an agent's diff looks bigger than it is.
- **Expand unchanged lines** lets the reader see the code around a hunk without leaving the panel. Today `-U3` is all there is, and `DiffLines` in `web2/src/components/right-panel/DiffView.tsx` knows only hunk text.

Run scope: split view works in every scope. Ignore-whitespace and expand-context are offered in `workingTree` and `branch`; in `run` scope they are offered only while the run's checkpoint is `live` (T30/T31), and are disabled with "Not available for this run" for journal-derived runs and after retention (a journal run has no whole-file contents; stored checkpoint patches are frozen at -U3 with whitespace on).

Not in this slice: comments (T29), checkpoints (T30/T31), any bridge change. Everything the slice needs from the bridge is named under Dependencies; a gap there is an Open question for T26.

## Change

### Preferences (per device)

`web2/src/rightPanelStore.ts` gains `diffLayout: "stacked" | "split" | null` and `diffIgnoreWhitespace: boolean`, with setters, next to `diffWrap`. Same plumbing as `diffWrap`: listed in `partialize` (written only when set), validated in `merge` (a wrong type is ignored), same key `sightr:v2:right-panel-state:v1`, no version bump, `safeStorage` try/catch. `null` means stacked. Whitespace defaults off. Exports `useDiffLayout()` like `useDiffWrap()`. `rightPanelStore.test.ts` gets the same persist/garbage cases `diffWrap` has.

### Split view

- **When offered.** Both must hold: `useLayout() === "desktop"` (viewport >= 1024 px, `DESKTOP_QUERY` in `web2/src/hooks/useLayout.ts`) and the diff column, measured with a `ResizeObserver` on the panel's scroll region (content box, padding excluded), is >= 640 px, so each side gets >= 320 px (about 44 monospace columns at 12 px). Hysteresis: once split, it stays until the column drops below 624 px. The panel is 320-720 px wide (`RIGHT_PANEL_MIN/MAX`), so split shows only when the operator drags the panel near its maximum, or T27 gives the diff a wider surface (see Open questions). Pure helper `splitAvailable({layout, columnPx, wasSplit})` in `diffLayout.logic.ts`.
- **Header.** A Stacked | Split segmented control beside Wrap and Collapse all (same `Button size="xs" variant="ghost-muted"`, `aria-pressed`). Rendered only when `splitAvailable`. The phone sheet and any narrow column never show it and never render split, even if the stored pref says split.
- **Crossing the breakpoint** (resize, rotate, panel drag, sidebar toggle): the effective layout switches at once, the stored pref is untouched, so widening brings split back. Expanded gaps, collapsed files and wrap are unaffected; the view re-anchors on the file header that was topmost (`scrollIntoView` on that header) because heights differ between layouts.
- **Pairing** (`pairHunkLines(lines)` in `diffSplit.logic.ts`, pure): context lines sit on both sides with both numbers. Within a hunk, a run of `-` lines followed by a run of `+` lines pairs 1:1 in order; the longer run's surplus pairs with an empty filler cell on the other side. A lone `-` or `+` run pairs with filler. `\ No newline at end of file` stays on the side of the line before it. Line numbers come from the hunk header `@@ -a,b +c,d @@`. A hunk with a bare `@@ @@` header (journal-derived, T24) pairs the same way and shows blank numbers.
- **Wrap and long lines.** Split honours the Wrap pref. Wrap on: one CSS grid row per pair (`1fr 1fr`), so a long line wraps and the opposite cell stretches to match. Wrap off: one `overflow-x-auto overscroll-x-contain` box holds the whole grid with columns `minmax(50%, max-content)`; both sides scroll together, rows stay aligned because lines are single-height. Stacked is unchanged.

### Ignore whitespace

- A toggle in the header ("Ignore whitespace", `aria-pressed`) on every layout. Turning it on refetches the file list and each *opened* file's patch with `ignoreWhitespace=1`; the bridge's `git diff -w` is the **single mechanism**. T3's client-side whitespace-only hiding in `lib/diffRendering.ts` is not used: it would be a second definition of "whitespace-only" that disagrees with the counts, and Sightr has no renderer-neutral parse of its own to hide with. If a later slice ports `diffRendering.ts`, the ledger note must say the hiding branch is left out.
- **Cache key** of T27's per-file patch cache and file-list cache gains `ws: 0 | 1`. Both variants stay cached for the session, so toggling back is instant. Opened files refetch lazily (T27's concurrency cap 4 applies); files not yet opened fetch with the current flag when first opened.
- **`diffHash`** (from T26) differs between modes by design. It is compared only within one `(scope, ws)` variant to detect "changed since fetched"; a refresh that changes it drops that variant's patches and contents cache for the scope. The toggle itself never counts as a change.
- **File list under `-w`.** A file whose only changes are whitespace may have zero hunks. The tree keeps such a file, marked "whitespace only" with no expander, so the tree does not jump on toggle. (Whether numstat under `-w` lists it is T26's call; see Open questions.)
- **Expanded context.** Expansion state is per `(file, ws)` and is reset when `ws` flips or `diffHash` changes, because hunk boundaries move and a gap index would point at the wrong gap. Under `-w`, lines that differ only in whitespace are part of a gap and expand as unchanged, shown from the new side.
- **Line numbers** (T24/T29) are real file numbers read from the hunk headers; `-w` does not renumber, so a number means the same line in both modes. T29 anchors `{side, lineNo}`; whitespace-only changed lines exist only with `ws=0`.

### Expand unchanged lines

- **Controls.** Each gap gets a row: before the first hunk, between hunks, after the last. Step 20 lines. First gap: "20 more above" (grows toward the file top from the hunk) and "Show all N". Last gap: "20 more below". Between: "20 more below the previous hunk" (down arrow), "20 more above the next hunk" (up arrow), "Show all N". A gap of <= 20 lines is one "Show N lines" button. When the revealed counts cover the gap the row disappears and the hunks merge visually. Rows use `pointer-coarse:py-2.5`; no hover-only affordance (it works on a phone).
- **Gap math** (`diffGaps.logic.ts`, pure). For a hunk with header start `s` and count `c` (count defaults to 1; `c = 0` means `s` is the line *before*): `first = c === 0 ? s + 1 : s`, `end = first + c`, on each of the old and new sides. Gap before hunk 0 is new `[1, first_0)`; between hunks `i`, `i+1` it is `[end_i, first_{i+1})`; after the last it is `[end_last, total + 1)`. The old/new gap lengths must match; if not, controls for the file are dropped. `total` is the new side's line count from contents: split on `\r?\n`, a final empty piece after a trailing newline is not a line, an unterminated last line is.
- **Data.** T26's contents route returns both sides' text for a file; the client fetches it **once per file on the first tap of any control** (not on render) and caches it by `(scope, path, diffHash)`. `web2/src/lib/diffFileContents.ts` is `pattern` of T3 `lib/diffFileContents.ts`; helper `fetchDiffFileContents` in `web2/src/lib/api.ts`. Revealed rows take their **text from the new side** and carry both numbers: `newNo` from the gap start, `oldNo = newNo - delta`, where `delta` is `newEnd_i - oldEnd_i` of the preceding hunk (0 before the first).
- **States.** No controls, one muted note, for: binary ("Binary file"), too large (over T26's contents cap: "File too large to expand"), refused (hidden/secret path: counted not shown, same wording as the Git tab). Added and deleted files have one hunk covering everything or no new side: no gaps, no controls. A truncated patch (T26's `truncated`): hide the after-last control (the tail is unknown). A fetch failure shows "Couldn't read this file" with a retry; the patch stays.
- **Staleness guard.** Before showing revealed rows, the first and last context line of each adjacent hunk are compared with the contents at the computed position. A mismatch (the file changed after the diff) hides the controls and shows "File changed since this diff. Refresh."
- **Seam.** `DiffCodeView` gains `layout`, an optional `expand` object `{contents: Loader, state}`, and its adapter exports `supports: {split, expand}`. If T25's adapter has native split or expand (T25 records which), the panel passes the props through and the hand-rolled `diffSplit.logic.ts`, `diffGaps.logic.ts` and their components are **not built**; their fixtures run at the seam instead, the same assertions on the rendered rows. If the adapter lacks one, the hand-rolled path builds it for that feature only. Preference, breakpoint rule, whitespace refetch and contents cache are renderer-independent and always built.

### Ledger (`web2/t3-upstream.json`)

| Local | Upstream (T3 `3a4d118a518a`, verify at build) | Mode |
|---|---|---|
| `src/lib/diffFileContents.ts` | `apps/web/src/lib/diffFileContents.ts` | pattern (Sightr fetch, no Effect; the loader shape and the old/new pairing idea) |
| `src/rightPanelStore.ts` (existing row) | `apps/web/src/rightPanelStore.ts` | note extended: `diffLayout`, `diffIgnoreWhitespace` |

The header toggles live in T27's `DiffPanel` row (pattern); no new T3 file is copied. The `decisions` skip for `DiffPanel.tsx` is replaced by T27; this slice adds none.

## Invariants

- A phone, and any column under 640 px (624 once split), renders stacked with no toggle; the stored pref is never rewritten by a layout change.
- Whitespace filtering happens only in the bridge (`-w`); the client never edits a patch.
- The contents route is called at most once per `(scope, path, diffHash)` and never before a user taps a control; nothing here runs when the panel is unmounted.
- Expanded rows are read-only, selectable text, and carry correct numbers on both sides or none.
- No bridge change. Wrap, collapse and the per-thread memory in T27 keep working in both layouts.

## Tests

Vitest, beside source, no network (msw for routes).

- `diffLayout.logic.test.ts`: `splitAvailable` at 1023/1024 px, 639/640/624 columns, hysteresis, phone with pref split.
- `diffSplit.logic.test.ts` (fixtures): 3 deletions vs 1 addition, 1 vs 3, deletion only, addition only, context-only, interleaved runs, no-newline marker on each side, bare `@@ @@` hunk.
- `diffGaps.logic.test.ts` (fixtures): gap before first, between, after last; hunk at line 1 (no first gap); `c = 0` pure insertion and pure deletion headers; file ending with and without newline (EOF off-by-one, last line shown once); `\ No newline` last line; CRLF content; old/new delta after an inserting hunk; mismatching gap lengths drop the controls; step 20 and show-all arithmetic.
- `lib/diffFileContents.test.ts`: one fetch per file for many taps, cache by `diffHash`, refresh with a new hash refetches, binary/too-large/refused map to states, abort on unmount.
- `rightPanelStore.test.ts`: both prefs persist, invalid values ignored, `diffWrap` untouched.
- `DiffPanel.split.test.tsx`: `setViewportWidth` 1280 then 390 (`web2/src/test/media.ts`) hides the toggle and shows stacked while the pref stays split; back to 1280 restores split; wrap on/off renders the right structure.
- `DiffPanel.whitespace.test.tsx`: toggle sends `ignoreWhitespace=1` for opened files only; both variants cached; toggling back makes no request; expansion resets; a whitespace-only file stays listed.
- `DiffPanel.expand.test.tsx`: tap shows 20 lines with correct numbers; show-all merges hunks; added/deleted/binary/refused/truncated states; stale-content guard.
- **Live** (scratch herdr workspace, repo with a reindented file, a long-line file, a file touched at line 1 and at EOF without a trailing newline): desktop width >= 1280 with the panel dragged to max: split appears, pairing and wrap checked on the long-line file; narrow the panel and the viewport to 390 px in `ca`: stacked, no toggle, expand rows reachable by thumb, no horizontal page scroll; toggle ignore-whitespace on the reindented file; expand all three gap kinds.

## Open questions

- **T26:** does `numstat -w` list a whitespace-only file (as 0/0)? If not, the tree needs the unfiltered list as well, or T26 must keep the file with a flag.
- **T26:** the contents route must say binary / too large / refused and return the new side for a deleted file as absent, not empty; confirm the shape and the size cap before building.
- **T27:** at the 720 px panel cap, split is rarely offered. Should the diff panel get a "widen" or full-width mode on desktop? Out of this slice unless T27 already has one. **Built in T28 as a stopgap:** the wide layout's file column is 256 px, and 720 - 256 < 640, so split could never show; a "File list" button (per device, `diffFileList` in `rightPanelStore.ts`) hides that column so the diffs get the whole panel. A real widen or full-width mode is still open.
