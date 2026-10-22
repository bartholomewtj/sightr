# 28 — The bridge stops importing `web/`

Status: done — #145. Written 22 Oct 2026 as Phase 2.1 slice 2 of the plan in
[`../ARCHITECTURE-ASSESSMENT.md`](../ARCHITECTURE-ASSESSMENT.md) (issue #145). Slice 1 (#141) moved 39
modules into `shared/harness/`; this is the last four, and after it the bridge imports nothing from
`web/`, which unblocks Phase 2.2 (retire v1, #146).

## Problem

`web/` is a React app, but four of its modules are a **server** runtime dependency: the bridge imports
them at runtime, so v1 cannot be deleted and any change to them risks the server. Slice 1 moved the
React-free `blocks`, `composer-kit` and `dialog-contract` into `shared/harness/` and left one-line
re-exports at the old paths. The same four are still where they were:

| Module | Bridge importers |
|---|---|
| `web/src/lib/guarded-send.ts` | `bridge/guarded-send-route.ts` |
| `web/src/lib/dialog-recipes.ts` | `bridge/threads/free-text.ts`, `bridge/threads/respond.ts` |
| `web/src/lib/harness/dialog-kit.ts` | `bridge/threads/free-text.ts`, `bridge/threads/request-ingest.ts`, `bridge/threads/respond.ts` |
| `web/src/lib/harness/dialog-sniff.ts` | `bridge/state-engine.ts`, `bridge/threads/compaction-watch.ts`, `bridge/threads/dispatch.ts` |

## Change

- Move each module to `shared/harness/` — `guarded-send.ts`, `dialog-recipes.ts`, `dialog-kit.ts`,
  `dialog-sniff.ts` — keeping its import closure free of `react`, `@shared`, `@/` and `@v1`.
- Leave the old path as a one-line re-export, exactly as slice 1 did:
  `export * from "../../../../shared/harness/X.ts";` (`../../../` from `web/src/lib/`).
- Re-point the bridge importers named above at `shared/harness/…`.
- Move each module's colocated test with it.
- The web-side callers (`web/src/lib/reply-action.ts`, `web/src/lib/harness/guard.ts`,
  `web/src/lib/multi-select-action.ts`, `web/src/lib/preview-action.ts`) keep the shim path.
- No `CHANGELOG.md` line: nothing operator-visible changes.

## Invariants

- `shared/harness/` holds no `react`, `@shared`, `@/` or `@v1` import. The root typecheck runs before
  the web install in CI, so a `react` import there breaks the build.
- Every old path still resolves to the same module, so v1 and web2 keep working unchanged.
- Herdr method names stay in `bridge/herdr-client.ts`; the moved modules reach `shared/` by relative path.
- No new contract field; `shared/v2/contracts.ts` is untouched.

## Tests

- Each module's existing test moves with it and stays green.
- A conformance test over `shared/harness/` that fails on a forbidden import.
- Root `bun run test` (typecheck + bridge + scripts + shared) and the web2 suite stay green.
- Exit: `grep -r "../web/" bridge/` is empty.

## As built

Landed: the four named modules, their full closure (19 modules — the adapter internals
`agy/index`, `agy/prompt-select`, `claude/{index,menu,multi-select,permission-subject,preview-select,prompt-select,wizard}`,
`cursor/index`, `grok/index`, `pi/{index,ask}`, `harness/types.ts`, `no-echo.ts`), and `sw-routes.ts`
(it was still imported by `bridge/auth-path-contract.test.ts`, so the exit grep would otherwise fail).
Each old path is the one-line `export *` shim slice 1 left; the bridge importers named above and that
test now point at `shared/harness/`. The conformance guard is `scripts/shared-harness-imports.ts`
(+ test) — kept in `scripts/` because web2's tsc compiles `shared/` but has no `bun:test` types. The
one web-side guard that read the module's own source (`web/src/lib/dialog-recipes.test.ts`) now reads
it at its shared path. Rebuilt web2: the thread-route closure is unchanged (29 files, 1,692 KB raw /
507 KB gzip), so #155's budget still passes.
