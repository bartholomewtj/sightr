# Diffs series runbook (T24–T31)

How a session orchestrates the build. Design and decisions: [`README.md`](README.md) "Diffs series" and the
eight specs. This file is only the process, the order and the model split. Written 18 Oct 2026.

## Roles and models

The orchestrator (the main session) reads, plans, spawns, checks and merges. It does not write slice code.

| Work | Model | Why |
|---|---|---|
| Build one slice | **Sonnet** (`model: "sonnet"`) | Specs are concrete: named files, caps, tests |
| Review a slice (read-only, diff + spec) | **Sonnet** | Checks invariants and tests against the spec |
| T30 core: snapshot mechanism, private store, store migration, contract | **Opus** | Safety invariants, git plumbing, Windows quirks |
| T30 safety review: user's `.git` untouched, secret names, caps | **Opus** | Wrong here writes into or leaks from a repo |
| T26 review: hardening, refusal list, root containment, process limits | **Opus** | Same attack surface as `bridge/workdir-git.ts` |
| T27 review: `useSheetHistory` change, store, tree | **Opus** | Cross-cutting UI change with a Back-button trap |
| T25 decision from the measured table | **Opus** | A judgment call that T27–T29 inherit |
| Live phone-width check (`ca`, scratch bridge) | **Sonnet** | Click-through with a fixed checklist |

Everything not listed is Sonnet. When a Sonnet builder reports it is blocked on a design question, the
orchestrator answers or escalates to Bart; it does not switch the builder to Opus mid-run.

## Order and parallelism

```
Wave 1:  T24 (web2)   T25 (spike)   T26 (bridge)      three runs, three worktrees, in parallel
Wave 2:  T27 (web2)                                    needs T25 decision and T26
Wave 3:  T28 (web2)   T29 (web2)   T30 (bridge)        parallel; T28 and T29 touch T27's files, so land one at a time
Wave 4:  T31 (web2)                                    needs T24, T27, T30
```

- **One spec per run.** A run is one builder agent in its own worktree and PR. Waves run several runs side by side; two specs are never in one agent.
- **Shared files conflict.** `web2/t3-upstream.json` and `CHANGELOG.md` Unreleased are touched by every slice. The orchestrator rebases the second PR of a wave onto the first after it merges; builders do not resolve those conflicts.
- **Store migration 7 is T30's.** No other slice adds a migration.
- **Stop at T25.** T27 cannot start until the renderer decision is written into `README.md` (the spec's thresholds decide it; Opus writes it up).

## Per-slice loop

1. **Orchestrator brief.** Read `CONTEXT.md`, `STATE.md`, the spec, and the specs it depends on. Pick the model from the table. Spawn the builder with `isolation: "worktree"` on branch `feat/Tnn-<name>`.
2. **Builder prompt contains:** the spec path (read it whole), "one spec only, do not implement a sibling", the standing rules from `CONTEXT.md`, the commands below, and the rule that `CONTEXT.md` and `DECISIONS.md` are never edited. It installs deps in the worktree (`bun install` in root, `web`, `web2`; web2 imports `web/src`).
3. **Verify-at-build items.** Every "verify at build" or "confirm at build" line in the spec is the builder's job. T3 source is not installed. Run `bun scripts/t3-upstream.ts --ref main` once to fill the cache, then read it with `git -C %LOCALAPPDATA%\sightr\t3-upstream\<repo> archive <sha> <paths> | tar -x -C <scratch dir>` (the cache has no checkout). Never install or build T3. Record what was found in the PR description.
4. **Builder deliverable:** code, the spec's tests, ledger rows (`web2/t3-upstream.json`, header line on adapted files), one CHANGELOG Unreleased entry in the file's plain voice, and a PR to `main` that has not been merged. It reports what it verified and what it could not.
5. **Review.** A read-only reviewer gets the spec and `git diff main...HEAD` (not the builder's summary) and reports invariant breaks, missing tests and spec drift. Opus for the rows marked Opus above, Sonnet otherwise. The builder fixes; one re-review at most.
6. **Gates (orchestrator runs them itself, in the worktree):**
   - `bun run test` (root typecheck + bridge + scripts), then `cd web && bun run test`, then `bun scripts/web2-harness-ids.ts`, then `cd web2 && bun run test`.
   - `bun scripts/t3-upstream.ts --ref main` lists the slice's rows as `unchanged`.
   - Build into a temp `--outDir`, never `web2/dist` (the live plugin serves it). Then `git checkout -- web2/src/routeTree.gen.ts`.
7. **Live check** for anything a user sees, per the spec's Tests section: scratch herdr workspace you create, dev bridge on its own port (`SIGHTR_PORT`, `SIGHTR_STATE_DIR=<temp>`, `SIGHTR_TRUSTED_USER_OPTIONAL=1`, `SIGHTR_SKIP_SERVE=1`), a phone-width browser through `ca`. Never type into panes you did not create. Never run Claude's `/model` or `/effort` in a test pane. Stop a bridge by killing its port (a `nohup bun` survives a plain stop). Touch long-press, `pointer-coarse` and the iOS keyboard inset cannot be checked in a desktop browser; the PR says so.
8. **Merge.** The orchestrator asks Bart before merging each PR unless Bart has said to merge on green. After a merge: pull `main`, delete the branch, rebase waiting PRs.

## What stays with Bart

- Merging, unless told otherwise. Releases (`bun scripts/bump.ts minor --note …`). Any `DECISIONS.md` row (ask first, cap 15).
- T25's reference phone and OS for the paint budget (the spec assumes his phone).
- A real-phone trial after T27 and again after T29: long-press, keyboard inset, split-view breakpoint.
- Anything a builder or reviewer finds that reverses a decision recorded in the README "Diffs series" section.

## End of each session

Rewrite `STATE.md` whole (not append): which slices are merged, which PRs are open, the next action. Delete lines that stopped being true. Keep the "Not checked on a real phone" list current.

## Decisions already made (do not re-ask)

Private store, default on; patches in SQLite so archived runs still show; `mod+d` kept; Git tab "Changes" becomes a link to the Diff panel; branch scope committed-only; overlapping threads snapshot anyway and flag `shared`; objects kept for the retention window (50 runs, 14 days, 24 h after archive, 256 MiB per repo); comments become quoted text in the plain composer; rollback, staging, revert, commit and push stay out. Full list: README "Diffs series" and each spec's "Open questions".

## Outcome (built 18–19 Oct 2026)

All eight slices merged in the planned order: T24 (#103), T26 (#104), T25 (#105), T27 (#106), a CI fix (#107), T28 (#108), T29 (#110), T30 (#109), T31 (#111). `main` `1a9324a`; the live bridge was rebuilt from it on 19 Oct (`v1.2.1+1a9324a`, no version bump yet). Merges were on a clean review, local gates and green CI, as Bart allowed for this series.

What the process got right: one spec per worktree, read-only reviewers on the diff, and the orchestrator running the gates itself caught real problems in every slice. What it under-estimated: **T30**. The loop allows one re-review; T30 needed four rounds. The first Opus review found 8 issues (shallow repos, mtime freshening through the alternate, 8.3 short names leaking `.env`, runs stuck `pending`). The fix round itself caused a regression (CRLF-committed files diffed whole-file under `autocrlf` because writers lost the alternate; sparse indexes still freshened user objects) which the re-review caught. A scoped Opus verification of round 3 found a conflicted file's mode lost under `filemode=false` and the machine-wide `core.autocrlf` overriding the repo's own since the first commit; Linux CI then exposed a git 2.52/2.55 cache-tree difference. Round 4 (snapshots own every tree; `addLiteral` for conflicted paths; `config --show-scope`; gc-first sweep) was verified by the reviewers' probes, the suites and CI only. Lesson for the next bridge slice that touches a user's repo: budget two Opus rounds and a probe script from the start, and treat "a fix changed the mechanism" as a new review, not a re-review.

Deviations recorded in the specs: T29 keeps comments off on unnumbered run-scope hunks and did not build long-press; T30's snapshot commits have no parent, `hidden` counts stat changes of refused tracked files, a new absent reason `sparse-checkout`; T31 infers "Off for this bridge" from the newest run and draws no card for a run with no net change and no journal edit.

Still unverified: everything on a real phone (touch targets, long-press, iOS keyboard inset, momentum scroll against the gutter, T31's badge/sheet/picker), the T31 picker buttons and failed-load Retry live, and Linux-only git paths beyond CI. Follow-ups (bridge, web2, hardening, review process) were collected in the orchestrating session's scratchpad `followups.md` and are listed in `STATE.md` until filed as issues.
