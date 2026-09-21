# 05 — Agy trust keys

Council row 5. Severity: high. Parser.

## Why

`parseOptionRow(..., isTrust)` in `web/src/lib/harness/agy/prompt-select.ts` maps unnumbered `Yes`/`No` rows to `{ n: 1 | 2 }`. The adapter then sends keys `["1"]` / `["2"]`. Fixture `agy--trust-prompt.txt` footer is arrow-navigate plus `enter Confirm`. ADR 0009: a generic menu is driven by the keys it names, never by invented digits. `describeAdapterConformance` only bans invented digits on `menu` blocks, not `prompt-select`.

Cursor already has `detectTrustRegion`; Pi ask walks a pointer. Copy that shape, not Claude numbered-option shape.

## Do

- Lift Agy trust like Cursor `detectTrustRegion` / Pi ask: pointer walk plus Enter (or a live-probed letter the footer actually prints). Do not synthesise `1`/`2` when the row is unnumbered.
- Extend the conformance digit ban to every `prompt-select` whose footer did not print those digits (not only `menu`).
- Keep numbered Agy prompt-select rows that **do** print digits on the option line.

## Do not

- Carry whistlr.decision on this card (row 4).
- Change Cursor/Pi trust detectors except to share a tiny pointer+Enter helper if that is smaller than copying.
- Add a new dialog grammar family.
- “Fix” trust by sending the words Yes/No as `sendWord`.

## Files

| File | Change |
|---|---|
| `web/src/lib/harness/agy/prompt-select.ts` | Stop mapping unnumbered Yes/No to n=1/2 keys |
| `web/src/lib/harness/agy/` (trust detector if split) | Pointer + Enter |
| `web/src/lib/harness/conformance.ts` | Digit ban on prompt-select without printed digits |
| `web/src/lib/harness/agy/agy.test.ts` and fixtures | Trust card sends Enter (and arrows if needed), not `1` |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- `agy--trust-prompt.txt`: Yes tap does **not** send `["1"]`. It sends the key the footer names (Enter, after highlight if needed).
- Numbered Agy prompt-select fixtures still send the printed digit.
- Conformance: a prompt-select whose footer has no digits fails if the model’s keys are invented digits.

## Done means

Tapping Yes on an Antigravity trust card sends the key the TUI consumes.
