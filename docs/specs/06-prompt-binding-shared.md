# 06 — One prompt-binding matcher

Council row 6. Severity: high. Parser + form.

## Why

`bridge/prompt-binding.ts` `normalizePromptRegion` strips SGR, then trailing whitespace and blank lines. `web/src/lib/harness/conformance.ts` `normalizeRegion` / `lastMatchEnd` reimplement the same matcher **without** stripping SGR. They share only `PROMPT_TAIL_LINES` from `shared/limits.ts`. The function the bridge 409s on (`verifyExpectedPrompt`) is not the function conformance tests.

`web/src/fixtures/prompt-binding-regions.json` and both `prompt-binding-contract` tests pin only Claude `detect*` regions. Grok/Cursor/Pi/Agy dialog `signature`/`region` never go through `verifyExpectedPrompt`. `prompt-binding-contract.test.ts` `detectRegion` tries prompt-select before wizard/preview, which is the reverse of `claudeBuildBlocks`.

## Do

- Move the pure matcher (`normalizePromptRegion`, `verifyExpectedPrompt`, tail-window constant) next to `shared/decision-marker.ts` (same pattern: import-free shared module). Import it from `pane-write-routes.ts` / `prompt-binding.ts` and from conformance. Delete the web copy.
- Keep SGR strip in the one function.
- Generate regions from each adapter’s `buildBlocks` over its own corpus. Assert `verifyExpectedPrompt(rawFixture, contract.region(model))` inside `describeAdapterConformance`, matching **live** arbitration order (`buildBlocks`), not a hand-rolled detect order.

## Do not

- Change 409 reason strings or the write-route HTTP contract except to import the moved function.
- Implement whistlr wizard (row 4).
- Split `actions.ts` (row 12).
- Add fixtures that are not already in `web/src/fixtures/panes/` unless a harness has zero dialog fixtures.

## Files

| File | Change |
|---|---|
| `shared/prompt-binding.ts` (new) | Pure matcher |
| `bridge/prompt-binding.ts` | Re-export or thin wrapper |
| `web/src/lib/harness/conformance.ts` | Import shared; delete `normalizeRegion` |
| `web/src/lib/harness/prompt-binding-contract.test.ts` | All adapters; `buildBlocks` order |
| `web/src/fixtures/prompt-binding-regions.json` | Regenerate or replace with per-adapter generation |
| `CHANGELOG.md` | Unreleased Fixed (internal; one line is enough) |

## Tests

- Existing `bridge/prompt-binding.test.ts` SGR / padding / indent cases still pass against the shared function.
- A Grok (and Cursor/Pi/Agy if they have dialog fixtures) region from `buildBlocks` verifies against the raw fixture.
- A Claude detector-order mismatch (prompt-select before wizard) is **not** how conformance walks; `buildBlocks` order is.
- Web conformance does not keep a second matcher.

## Done means

A tail-window or blank-line change is one edit. CI tests the function the bridge actually 409s on, for every harness with dialog fixtures.
