# T25 — A measured spike picks the diff renderer, behind one seam

Status: built and merged 2026-10-19 (PR #105; diffs series). Build-time amendments are recorded in this file. Depends on: T23 (method, `SIGHTR_COMPILER` flag pattern), T20 (ledger `decisions`); builds on
`web2/src/components/right-panel/DiffView.tsx` (`parseDiff`, `lineStyle`, `DiffLines`). Plan:
[`docs/T3_ADAPTATION.md`](../../T3_ADAPTATION.md), "React Compiler spike" in [`README.md`](README.md).

## Problem

T27 (diff panel), T28 (split, expand-context) and T29 (line comments) all draw code lines. T3 uses
`@pierre/diffs`; its licence and bundle cost were never checked here, it runs a web worker, and Sightr's
CSP is strict (`worker-src 'self'`, `script-src 'self'`, no `wasm-unsafe-eval`; `bridge/responses.ts:18-21`).
Sightr's own renderer (`parseDiff`, `lineStyle`, `DiffLines` in `DiffView.tsx`) is 63 lines with no
highlighting, no line numbers, no split view and no expansion. The ledger `skip` for T3's `DiffPanel.tsx`
says "@pierre/diffs never taken", which the series reverses only if the numbers support it. Choosing by
taste would cost a rewrite of T28/T29 later, so T25 measures first and fixes the interface they code
against. It changes no shipped behaviour.

## Change

**Candidates.** (A) `@pierre/diffs` plus its worker pool, loaded lazily; `@pierre/trees` is a beta and is
not a candidate (T27 builds the file tree locally). (B) A hand-rolled renderer on `parseDiff`/`lineStyle`
plus a light highlighter: a small `highlight.js` core with per-language lazy imports, or a `shiki` subset
(JS regex engine, one theme, 10-12 grammars). Both are candidates to be checked at build (size, licence,
engine); the spike may swap one for another. (C) Status quo, no highlighter.

**The seam, `web2/src/components/diffs/DiffCodeView.tsx` (types and a thin wrapper).** All later slices
import only this:

```ts
type DiffSide = "old" | "new";
type DiffLineRef = { filePath: string; side: DiffSide; line: number };      // 1-based, from the hunk header
type DiffCodeViewProps = {
  patch: string;                        // one file's unified diff (what `parsePatch` splits out)
  parsed?: ParsedPatchFile;             // optional, skips a second parse
  filePath: string;                     // picks the grammar; never an absolute path
  wrap: boolean;                        // phone default true (the existing `diffWrap`)
  layout?: "stacked" | "split";         // adapters without split render stacked and say so via `capabilities`
  annotations?: { at: DiffLineRef; key: string }[];            // T29 anchors
  renderAnnotation?: (a: { at: DiffLineRef; key: string }) => ReactNode;
  onLineAction?: (at: DiffLineRef) => void;                     // tap/click on a line gutter, T29
  onExpandContext?: (filePath: string) => Promise<{ oldText: string; newText: string } | null>; // T28
};
type DiffAdapterCapabilities = { split: boolean; expand: boolean; annotations: boolean; highlight: boolean };
```

`DiffCodeView` is `lazy(() => import("diffs-adapter"))` inside a `Suspense` whose fallback is the status
quo `DiffLines`, so a slow chunk never blanks the diff. Adapters sit in `web2/src/components/diffs/adapters/`:
`status.tsx` (wraps `DiffLines`), `hand.tsx` (B), `pierre.tsx` (A); each is under about 150 lines and
exports `default` component plus `capabilities`.

**`web2/src/components/diffs/parsePatch.ts` (Sightr code, tests beside it).** A hunk-aware splitter
returning `ParsedPatchFile { path, oldPath?, status: modified|added|deleted|renamed|binary, hunks[], additions,
deletions }` with old/new line numbers per line. The existing `parseDiff` mis-reads a removed line whose
text starts `-- ` (shown as `--- `) as a header via its `NOISE` regex, and cannot read quoted names; the new
parser is hunk-counted, not regex-guessed. `DiffView.tsx` keeps its own parser until T27.
`web2/src/t3/shared/gitPatchPath.ts` is ported `verbatim` from T3 `packages/shared/src/gitPatchPath.ts`
(git quoted-name decoder, verify at build that it needs no edit; otherwise `adapted`) with its test.
Ledger rows: that file (`verbatim`, T3 `main` commit at port time) and its test.

**Flag and harness, mirroring `SIGHTR_COMPILER`.** `web2/vite.config.ts` gains `SIGHTR_DIFFS=pierre|hand`
(default unset, which is `status`). Set, it aliases `diffs-adapter` to that adapter and adds a
`spike-diffs.html` build entry (a page that renders the fixtures and prints timings on screen). Unset, the
alias is `status`, the entry is absent and nothing else changes. The candidates' packages are not added to
`package.json`; to measure, install them unsaved and pinned, as the T23 comment does:
`bun add -d --no-save @pierre/diffs@<exact>` (and the highlighter). `tsconfig.json` excludes `pierre.tsx` and
`hand.tsx` so a normal typecheck and `bun run build` never need the packages.
`scripts/diff-spike.ts` (Bun) has subcommands `fixtures` (deterministic patches, seeded, written under
`web2/.spike-diffs/`, ignored by git), `jsdom <adapter>` (runs the vitest harness
`web2/src/components/diffs/spike.harness.test.tsx` and prints a markdown row) and `report` (merges the rows,
including the browser numbers pasted from the harness page, into the README table).

**Fixtures.** Small: 50 lines, one file. Medium: 1,500 lines, 3 files. Large: 10,000 lines over 40 files
(including one 3,000-line file with 400-char lines, a rename, a binary and a deleted file). The language
mix is the top 12 extensions of changed files in this repo's `file_change` history (`threads.sqlite`,
read-only, extension counts only) so "coverage" is measured on real use.

**Thresholds, fixed before any measurement.** A candidate is adopted only if every row passes.

| Measure | Pass |
|---|---|
| Licence of the package and every runtime dependency it pulls in (manifests and LICENSE files, not READMEs) | MIT, Apache-2.0, BSD or ISC; anything else rejects |
| Main chunk gzip growth (seam and `Suspense` only; the adapter must be in a lazy chunk) | at most +2 KB |
| Lazy chunk, gzip: renderer, worker and grammars for one language | at most 150 KB; grammars load per language |
| Total `dist` JS gzip growth (the service worker precaches every `*.js`, `injectManifest.globPatterns`) | at most +400 KB, or the grammar chunks can be left out of the precache with a one-line `globIgnores` |
| Cold fetch of the lazy chunk over Tailscale on the phone (median of 5, SW cleared) | at most 1.0 s; warm at most 100 ms |
| First render, 50 / 1,500 lines (phone-width browser, 4x CPU throttle) | at most 50 ms / 300 ms |
| First paint of the first file, large patch (same, and once on Bart's phone) | at most 800 ms; no single long task over 250 ms |
| React commits for one first render (jsdom and browser) | at most 3; no re-render loop |
| Scroll jank, large patch, 5 s fling | p95 frame at most 20 ms; at most 10% dropped frames |
| Mounted DOM nodes, large patch | at most 5,000 (virtualised, or files rendered on open) |
| Heap, large patch (Chrome only; iOS has no `performance.memory`, recorded n/a) | at most +60 MB over the empty panel, within 20% of baseline after unmount |
| Worker, under `tailscale serve`, with the service worker active and the bridge CSP | zero `securitypolicyviolation` events and console errors; the worker is a same-origin file (a `blob:` or `data:` worker is blocked by `worker-src 'self'`); no WASM (the CSP has no `wasm-unsafe-eval`, and `CONTENT_TYPES` has no `.wasm`). If the worker cannot start the adapter must fall back to unhighlighted lines without throwing. CSP is not loosened to pass |
| Features behind the seam | split, expand-unchanged and line annotations are native, or proven in the harness in at most 150 adapter lines |
| Highlight coverage | at least 90% of the corpus's changed files by count |
| Touch and accessibility | line gutter tap target at least 44 px under `pointer-coarse`; text selectable; screen-reader order is old-then-new per row; no horizontal page scroll |

jsdom rows (commits, node counts, render count via the DevTools-hook fiber count as in T23) rank candidates;
only the browser rows carry time thresholds, because jsdom has no layout. The browser pass runs at 390 x 844,
Fast 4G, 4x CPU, then once on Bart's phone for worker/CSP, large-patch paint and scroll.

**Decision rule.** Adopt A if it passes every row. If A fails and B passes, adopt B. If both pass, take the
lower sum of ranks on lazy gzip and large-patch paint; a tie goes to B (we own it). If neither passes, C
ships behind the seam and T28/T29 build split, expand and annotations into `hand.tsx` without a highlighter.
The winner's adapter becomes the `diffs-adapter` default only in T27, the first slice that renders it; T25 leaves
the default `status`.

**Results and records.** `docs/specs/t3/README.md` gains "Diff renderer spike (T25, <date>): <decision>"
after the React Compiler section, with the measured table (versions, the numbers, which rows failed) and a
re-measure line (`SIGHTR_DIFFS=…`, the install command). `web2/t3-upstream.json` `decisions` gets rows for
`apps/web/src/components/diffs/StyledDiffCodeView.tsx` and `apps/web/src/lib/diffRendering.ts` (`skip`, with
the measured reason, or `defer` if adoption is pending T27's port) and updates the reason on the existing
`DiffPanel.tsx` row. `docs/T3_ADAPTATION.md` "never take" line for `@pierre/diffs` is edited only if A is
adopted.

## Invariants

- The default render path of the timeline (`ToolItemDetail.tsx` `OutputBlock`) and the Git tab
  (`GitPanel.tsx`, `DiffView.tsx`) is untouched until T27. Nothing under `web/` changes.
- With `SIGHTR_DIFFS` unset, `bun run build` output differs from today's only by the seam files (about 1 KB).
- No new entry in `package.json` or `bun.lock`. No CSP, route or service-worker change (the `globIgnores`
  line, if needed, is T27's).
- Read-only: no git write, no new bridge route. The harness reads `threads.sqlite` for extension counts only.

## Tests

- `web2/src/components/diffs/parsePatch.test.ts`: fixtures for rename (with similarity and no hunk), binary,
  no newline at EOF (`\ No newline` attaches to the preceding line, counts toward neither side), quoted names
  (`"a/caf\303\251 b.ts"` via `gitPatchPath`), CRLF (kept in the text, not counted as a line), a removed
  line starting `-- `, an added file, a deleted file, an empty patch, and a hunk whose counts disagree with its
  body (reported, not trusted).
- `web2/src/components/diffs/adapters.contract.test.tsx`: one `describe.each` over the adapters whose package
  resolves (others skip with the reason printed). Each renders the same patch and asserts: file path shown,
  added and removed lines distinguishable (not by colour alone), `wrap` changes layout, a 44 px gutter
  target under a forced `pointer-coarse`, `onLineAction` fires with the right `DiffLineRef` (old side for a
  removed line), `renderAnnotation` output appears under its line, `onExpandContext` is called once and the
  result reveals hidden lines when `capabilities.expand`, a failed expansion shows an error and leaves the
  diff intact, and unsupported `layout="split"` falls back to stacked.
- `scripts/diff-spike.test.ts`: `fixtures` is deterministic (same bytes twice) and `report` rejects a table
  missing a threshold row.
- Live (not unit-testable): the browser and phone pass above, with worker/CSP checked through
  `tailscale serve` against a scratch bridge, the service worker active, and the lazy chunk's request seen
  in the network panel. Record the device and OS in the README table.

## Not in this slice

The diff panel, scope picker, split toggle, whitespace toggle, expand UI and comments (T27-T29); `@pierre/trees`;
any bridge change (T26); replacing `DiffView.tsx`; adding a dependency to `package.json`.

## Open questions

- Which phone and OS version is the reference for the 800 ms paint budget? The thresholds assume Bart's.
- Is `.wasm` acceptable if a highlighter has no JS engine (needs `wasm-unsafe-eval` in the CSP), or does that reject it outright? The spec says reject.
