# T26 — Bridge review API: file list, lazy patches and whole-file contents for the working tree and a branch

Status: built and merged 2026-10-19 (PR #104; diffs series). Build-time amendments are recorded in this file. Depends on: `bridge/workdir-git.ts`, `bridge/workdir.ts` (Git tab, built 18 Oct), T20 (`shape` ledger mode, landed). Feeds: T27, T28, T29 (consumers), T30 (fills `scope=run`). Bridge and shared types only, no web2. Plan: [`docs/T3_ADAPTATION.md`](../../T3_ADAPTATION.md).

## Problem

`GET /api/files/git` and `/api/files/git/diff` hand the client one patch for the whole tree, capped at 256 KB (`DIFF_CAP_BYTES`), at `-U3`, with `--no-renames`. Untracked files are listed but never diffed, the base is whatever `resolveBase` picks, nothing is fetched per file, and there is no way to read a whole file. The diff panel (T27), expand-unchanged-lines (T28) and line comments (T29) need what T3 serves over `review.getDiffPreview` / `review.getDiffFileContents` (`contracts/review.ts`, `GitVcsDriverCore`): a cheap file list, then one patch or one file at a time. Sightr has no RPC layer, so this is plain HTTP next to the Git tab routes. The Git tab keeps its routes and behaviour (no change to its callers or its tests).

## Change

### Shared types: `shared/v2/review.ts` (new; ledger `shape` of T3 `contracts/review.ts`)

```ts
export const REVIEW_PATHS = { list: "/api/files/git/review", patch: "/api/files/git/review/patch", contents: "/api/files/git/review/contents", branches: "/api/files/git/branches" } as const;
export type ReviewScope = "working-tree" | "branch" | "run";            // "run" is reserved, see below
export type ReviewUnavailable = FolderGitUnavailable | "no-commits" | "no-base" | "bad-base" | "bad-commit" | "bad-file" | "busy";
export type ReviewFileKind = "added" | "modified" | "deleted" | "renamed" | "untracked";
export interface ReviewFileStat { path: string; oldPath?: string; kind: ReviewFileKind; added: number; removed: number;
  binary?: true; tooLarge?: true; whitespaceOnly?: true; rev: string }   // rev: per-file hash, see ETag contract
export type ReviewDiffPreview = { available: false; reason: ReviewUnavailable } | { available: true; scope: "working-tree" | "branch";
  base?: string; baseIsDefault?: boolean; from?: string; to?: string;    // branch only: base short name, merge-base oid, HEAD oid
  files: ReviewFileStat[]; hidden: number; truncated: boolean; diffHash: string };
export type ReviewDiffFilePatch = { available: false; reason: ReviewUnavailable } | { available: true; patch: string; truncated: boolean; diffHash: string };
export type ReviewSide = { state: "text"; text: string; crlf: boolean } | { state: "absent" } | { state: "binary"; bytes: number } | { state: "too-large"; bytes: number };
export type ReviewDiffFileContents = { available: false; reason: ReviewUnavailable } | { available: true; old: ReviewSide; new: ReviewSide; diffHash: string };
export interface ReviewBranch { name: string; remote: boolean; current?: true; time: number }
export type ReviewBranches = { available: false; reason: ReviewUnavailable } | { available: true; current?: string; detached?: true; defaultBase?: string; branches: ReviewBranch[]; truncated: boolean };
```

### Routes (`bridge/workdir.ts`, four branches beside `/api/files/git/diff`)

All GET, same read `guard`, same `path` = Files folder rel (`parseRelPath` + `resolveInRoot` + `isDirectory`, else 404), `cache-control: no-store`, answers `200 {available:false, reason}` for repo states exactly like the Git tab. The client gets the folder from `/api/files/pane-folder` as today (pane -> cwd -> contained rel path); the repo root is found by `openRepo`. No absolute path and no git stderr ever reaches the client.

| Route | Query | Returns |
|---|---|---|
| `/api/files/git/review` | `scope`, `base?`, `ignoreWhitespace=1?` | `ReviewDiffPreview` |
| `/api/files/git/review/patch` | `scope`, `file`, `oldFile?`, `from`+`to` (branch), `ignoreWhitespace=1?` | `ReviewDiffFilePatch` |
| `/api/files/git/review/contents` | `scope`, `file`, `oldFile?`, `from`+`to` (branch) | `ReviewDiffFileContents` |
| `/api/files/git/branches` | none | `ReviewBranches` |

- **Scopes.** `scope` other than the three values: 400. `scope=run`: 501 `{error:"run scope not available"}` (T30 fills it with a `runId`). `file`/`oldFile` are repo-root-relative (the `path` values the list returned), checked with `parseRelPath` (so the Files refusal list applies per segment) and, for a hidden path, answered 404 like any missing path.
- **`working-tree`**: tracked files vs `HEAD`, staged and unstaged merged. Why merged: the question is "what is different from the last commit", agents rarely stage, and a staged/unstaged split needs two lists, two hashes and index reads for no review value; there are no write operations to act on the split. A repo with no commits answers `no-commits`. Untracked files (`ls-files --others --exclude-standard -z`) are listed as `kind:"untracked"` and are all additions: lines are counted from a read of the file, binary (NUL in the first 8 KB, `sniffBinary`) is `binary`, a file over 1 MB or past a 8 MB per-list read budget is `tooLarge` with 0/0. Their patch is synthesized in TypeScript (`new file mode 100644`, `--- /dev/null`, one `@@ -0,0 +1,N @@` hunk, `\ No newline at end of file` when due), so no `--no-index`, no extra process, no path leak.
- **`branch`**: committed work only, merge-base of the base and `HEAD` vs `HEAD` (uncommitted edits belong to `working-tree`; this keeps the scope immutable and its hash computable from two oids). `base` is a short branch name from the branches route, resolved only as `refs/heads/<base>` then `refs/remotes/<base>` with `rev-parse --verify --quiet --symbolic-full-name`; it must match `/^[\p{L}\p{N}._\-/+@]{1,200}$/u`, not start with `-`, and contain none of `..`, `//`, `@{`, a trailing `/` or `.lock`; anything else is `bad-base`. No tags, no revision expressions. Omitted `base` uses `resolveBase` (upstream, `origin/HEAD`, `main`, `master`) and sets `baseIsDefault`. The list returns `from` (merge-base oid) and `to` (HEAD oid); the patch and contents calls take those two oids (`SHA_RE`/`FULL_SHA` hex only, `bad-commit` otherwise) so they cannot drift from the list and need no base resolution.
- **Branches**: `for-each-ref --sort=-committerdate --count=1000 refs/heads refs/remotes` with `%(HEAD)`, minus `refs/remotes/*/HEAD`, hidden-name-free, cap 200 (`truncated`), plus `defaultBase` from `resolveBase`.
- **Renames**: `-M` (default 50%) on the list and patch calls, replacing the Git tab's `--no-renames`, because a rename as delete+add doubles the review. Copies are not detected. A rename whose old or new path is hidden is counted in `hidden` and not listed. An unstaged `mv` has no index entry, so it shows as deleted plus untracked; documented, not fixed (fixing needs `add -N`, a write).
- **List data**: two parallel processes, `diff -z --numstat -M <rev>` and `diff -z --name-status -M <rev>`, joined on the new path (numstat renames are `added\tremoved\t\0old\0new\0`, name-status `R100\0old\0new\0`). Both parsers live in `bridge/workdir-review.ts` as a pattern of T3 `server/checkpointing/Diffs.ts` (47 lines, numstat `-z`), extended for renames and status letters; `parseNumstatRecord` cannot read rename records and is not reused. `-` counts mean binary. With `-w`, a non-binary `modified` file at 0/0 gets `whitespaceOnly` (verify at build whether git still lists it; the fixture decides). Cap 500 files (`MAX_STATUS_ENTRIES`), `truncated` also covers a capped untracked list.
- **Patch**: `diff -M --no-ext-diff --no-textconv --no-color --ignore-submodules=all -U3 [-w] <rev> -- :(literal,top)<file> [:(literal,top)<oldFile>]`. Cap 1 MB (`FILE_PATCH_CAP_BYTES`, T3's per-file limit), cut at the last whole hunk (`\n@@ `) so the patch still parses, `truncated:true`; one hunk over the cap gives `""` and `truncated`. The header is checked with the decoder below; a mismatch is `bad-file`.
- **Contents** (T28 expansion). Old side: `cat-file -s` then `cat-file blob <rev>:<oldFile ?? file>` where `rev` is `HEAD` (working tree) or `from` (branch). New side: the file on disk (working tree; `containedRealpath` under the repo root, `lstat` must not be a symlink, else `absent`) or `cat-file blob to:<file>` (branch). A side is `absent` when the path does not exist there (added, deleted, untracked old side), `binary` (NUL in the first 8 KB), or `too-large` over 1 MB (`FILE_CONTENTS_CAP_BYTES`), with no text. No check that the file is in the diff: Files already serves the same bytes. Text is UTF-8 (lossy, as `spawnGit` decodes). **Line endings:** the patch comes from git, which applies the effective `core.autocrlf`; so when it is `true` or `input` (export `readEffectiveAutocrlf` from `workdir-git.ts`, additive) the disk side has CRLF folded to LF to match the patch lines; with `false`/unset it is untouched. `crlf` reports whether the returned text still has CRLF. `.gitattributes` `eol` rules are not modelled.
- **Quoted names**: patch headers quote non-ASCII names (`"a/caf\303\251.txt"`; `core.quotepath` stays default on purpose). `shared/v2/gitPatchPath.ts` decodes C-style quoting with octal UTF-8 bytes and strips `a/` `b/` and `/dev/null`: an adapted port of T3 `packages/shared/src/gitPatchPath.ts` (118 lines; verbatim if it has no Effect import, the row says which). The bridge uses it for the header check; T27/T28 import it to key patches by path.

### ETag and `diffHash` contract

- `diffHash` is `sha256` hex (first 32 chars), also sent as `ETag: "<diffHash>"`. The client sends `If-None-Match`; a match answers `304` with the ETag and `cache-control: no-store`, empty body (same shape as `bridge/pane-read-routes.ts`, `notModified` from `bridge/http-cache.ts`).
- `ReviewFileStat.rev` = hash of that file's row (kind, counts, paths) plus, for a tracked working-tree file, its `lstat` size and `mtimeMs`; for an untracked file, its content hash (already read). Counts alone are not enough: swapping one line keeps 1/1. List `diffHash` = hash of every `rev`, `hidden`, `truncated`, the scope, the `-w` flag and the oids.
- Rule for the client (T27): keep a patch per `(file, rev, ignoreWhitespace)`; after a list refresh only files whose `rev` changed are re-fetched; an unchanged `diffHash` means nothing re-renders.
- `branch` scope hashes `(from, to, ignoreWhitespace)` before any diff runs, so a matching `If-None-Match` costs three cheap processes (base resolve, `rev-parse`, `merge-base`) and no diff. Patch and contents hash their own output; contents hash both sides plus `crlf`.

### Concurrency and limits (`bridge/workdir-review.ts`)

- One module `createFolderReview(workRoot, run)` holds the four handlers. `workdir-git.ts` gets a pure extraction: `openRepo`, `resolveBase` and the hardened `invoke` wrapper become exported top-level functions taking the runner, behaviour unchanged. If an existing test needs editing, stop: the extraction is wrong.
- Every review call is `[...prefix, "--no-optional-locks", <subcommand>, ...]` (the prefix, `GIT_OPTIONAL_LOCKS=0` and the scrubbed env stay as they are). Subcommand allowlist, asserted in tests: `rev-parse`, `merge-base`, `for-each-ref`, `diff`, `ls-files`, `cat-file`, `status`.
- Each process keeps the 10 s `GIT_TIMEOUT_MS` (killed on expiry); a request has a 25 s deadline (`timeout`). **Single-flight per repo:** identical in-flight requests (key: root, scope, from/to or base, `-w`, route, file) share one promise. **Process caps:** `REVIEW_MAX_GIT = 4` at once across the bridge, `REVIEW_MAX_PER_REPO = 2`, FIFO queue of 32, then `{available:false, reason:"busy"}`. Four matches T27's four concurrent patch fetches; process start on Windows costs tens of ms and these reads are single-threaded I/O, so four leaves room for the herdr client and the Git tab (its routes are not gated and can overlap). Both numbers are constants to tune after a measurement on the real box.
- Constants: `FILE_PATCH_CAP_BYTES` 1 MB, `FILE_CONTENTS_CAP_BYTES` 1 MB, `MAX_REVIEW_FILES` 500, `MAX_REVIEW_BRANCHES` 200, `UNTRACKED_READ_BUDGET` 8 MB. T3's 120 KB whole-patch preview is not reproduced: the list carries no patch, so there is nothing to preview. The Git tab keeps its 256 KB aggregate cap, sensible for one response holding every file; per-file lazy fetches can afford 1 MB, gzip through `h.json`.

### Ledger (`web2/t3-upstream.json`, T3 `3a4d118a…`)

| local | upstream | mode |
|---|---|---|
| `../shared/v2/review.ts` | `packages/contracts/src/review.ts` | shape |
| `../shared/v2/gitPatchPath.ts` | `packages/shared/src/gitPatchPath.ts` | adapted |
| `../bridge/workdir-review.ts` | `apps/server/src/checkpointing/Diffs.ts` | pattern |

Upstream paths verified at build (T3 not readable from here). The existing `skip` decision for `DiffPanel.tsx` stays until T27 ports it. This slice edits neither `CONTEXT.md` nor `DECISIONS.md`.

## Invariants

- Read-only. No git command that writes or takes the index lock; no `add`, `checkout`, `stash`, `update-index`, `gc`, `fetch`.
- Hooks, pager, external diff, textconv, system/global config and color stay off exactly as `prefix` and `env()` have them; only `core.autocrlf` is passed back in.
- The client sees repo-relative paths, short ref names and oids only. A hidden path is never listed, diffed or read; it is counted in `hidden`. A `from`/`to`/`base` value can never be read as an option or revision expression.
- `/api/files/git` and `/api/files/git/diff` return byte-identical responses to today for the same repo.
- `scope=run` returns 501 until T30.
- NOT in this slice: any UI, checkpoints or hidden refs, staging, commit, revert, branch creation, PR data, per-run diffs.

## Tests

`bridge/workdir-review.test.ts` (new, the style of `bridge/workdir-git.test.ts`; fake runner for argv, real git in a temp repo for results, 30-60 s budgets), `bridge/workdir.test.ts` (route cases), `shared/v2/gitPatchPath.test.ts`.

- **Argv (fake runner):** every call carries the hardened prefix and `--no-optional-locks`, uses an allowlisted subcommand, literal top-anchored pathspecs, `-M`, `-w` only when asked, and nothing after `--` is read as a flag. `base`/`from`/`to`/`file` values `--output=x`, `HEAD`, `a..b`, `@{u}`, `x.lock`, `../x` are refused before git runs.
- **Fixture repo, working tree:** a rename (staged `git mv`) with an edit; a binary file; a CRLF file under `autocrlf=true` (clean, absent from the list) and one edited under `autocrlf=false`; an untracked text file, an untracked binary and an untracked 2 MB file (`tooLarge`); a deleted file; a file named `café.txt` (quoted header decodes, list path is raw); a 3 MB tracked file edit (patch `truncated` at a hunk boundary, still parses); `.env` and `config/x.json` changed (counted in `hidden`, never in output, `file=.env` is 404); a no-commit repo gives `no-commits`; an unstaged `mv` shows delete plus untracked.
- **Fixture repo, branch:** a remote-tracking base plus a picked local `release` base give different `from`; default base sets `baseIsDefault`; `branches` lists local and remote, hides `origin/HEAD`, marks current, caps at 200; a tag name as `base` is `bad-base`.
- **ignoreWhitespace:** a whitespace-only edit is `whitespaceOnly` or absent per the verified git behaviour, and its patch is empty under `-w`; a mixed edit keeps only the real change.
- **Contents:** old/new sides for modified, added (old `absent`), deleted (new `absent`), renamed (`oldFile`), untracked, binary, `too-large`, a symlinked file (`absent`); `crlf` flag and the autocrlf folding match the patch lines.
- **ETag:** same `diffHash` on an unchanged tree; changes when a line is swapped with equal counts (mtime/size in `rev`); `If-None-Match` gives 304 with no body; branch 304 runs no `diff` process (fake runner count).
- **Concurrency:** 10 identical requests spawn one set of processes; 8 distinct requests never exceed 4 running (counting runner); the 33rd queued request gets `busy`; a hung process is killed at the timeout and answers `timeout`.
- **Routes:** traversal, absolute and hidden `path` 404; bad `scope` 400; `scope=run` 501; read gate 403; the existing Git tab route tests pass unchanged; no response contains the temp root.
- **Decoder:** octal UTF-8, `\"`, `\\`, `\t`, `a/`/`b/` strip, `/dev/null`, and T3's own cases if its test file is copied.
- Live: none (no UI). Smoke with `curl` against a scratch bridge and a scratch herdr workspace is optional.

## Open questions

- Decided with Bart (18 Oct 2026): `scope=branch` is committed-only, like the Git tab and a PR view; uncommitted work is the `working-tree` scope. No toggle.
- Are 4 git processes, 2 per repo and the 25 s deadline right for Bart's PC? They are guesses until measured with T27 open on a large repo.
- Non-UTF-8 files come back lossy in `contents`; acceptable, or should they be marked `binary`?
