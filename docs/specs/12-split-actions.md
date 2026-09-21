# 12 — Split actions.ts along the jobs it already names

Council row 12. Severity: high. Form.

## Why

`web/src/lib/actions.ts` is 1179 lines (`submitMenuKeys` through `sendGuardedReply`). Tests are 2091 lines, still titled as merged modules. `web/src/lib/dialog-guard.ts` says “all five action modules” do the choreography **here**. `harness/types.ts`, ADR 0010, and `PLAN_FEEDBACK_NOTES.md` cite `lib/reply-action.ts` / `lib/prompt-action.ts` / `lib/grammar/` which are not on disk.

Behaviour must not change. This is a file split plus citation repair.

## Do

- Split `actions.ts` along the jobs the comments already name:
  - one file per dialog kind’s `submit*` (`submitMenuKeys`, `submitWizardKeys`, `submitPreview*`, `submitPrompt*`, `submitMultiSelectIntent`)
  - `sendGuardedReply` / `draftCarriesSend` in a real `web/src/lib/reply-action.ts`
- Keep a thin `actions.ts` barrel that re-exports the same names so existing imports (`use-pane-view.ts`, tests, harness tests) compile without a hunt.
- Split or section `actions.test.ts` to match; do not lose cases.
- Point `dialog-guard.ts`, `harness/types.ts`, ADR 0010, and any `PLAN_FEEDBACK_NOTES.md` citations at the files that exist. Do not resurrect `lib/grammar/`.

## Do not

- Change send recipes, guards, or whistlr `submitPromptOption` marked-card branch (row 4 is out of scope; leave that branch where it is).
- Relocate `dialog-guard.ts`.
- “Clean up” harness adapters while splitting.
- Rename exported functions.

## Files

| File | Change |
|---|---|
| `web/src/lib/actions.ts` | Barrel |
| `web/src/lib/reply-action.ts` (new) | Reply path |
| `web/src/lib/*-action.ts` (new, one per kind or one dialog-actions) | `submit*` |
| `web/src/lib/actions.test.ts` and/or colocated tests | Move with sources |
| `web/src/lib/dialog-guard.ts` | Citation |
| `docs/adr/0010-long-sends-are-verified-via-the-paste-placeholder.md` | Path names only |
| `CHANGELOG.md` | Unreleased Changed (internal split; one line) |

## Tests

- `cd web && bun run test` green; import graph still resolves `submitPromptOption` / `sendGuardedReply` / `draftCarriesSend` from `@/lib/actions`.
- Line count of any one action module << 1179; tests sit beside the module they cover.
- grep for `lib/reply-action.ts` / `lib/prompt-action.ts` hits files that exist, or those strings are gone.

## Done means

A new dialog kind or a reply-guard change no longer lands in an 1100-line file. The stated action-module map matches the tree.
