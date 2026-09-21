# 18 — Cursor autocomplete must not unbound-sweep

Council row 18. Severity: medium. Parser.

## Why

`AUTOCOMPLETE` fixtures are excluded from both conformance cohorts in `web/src/lib/harness/cursor.test.ts` because `composerReady` is true while `composerPrompt` returns null. `cursor/chrome.ts`: when non-blank rows below the composer box ≥ `PROMPT_TAIL_LINES`, `composerPrompt` returns null so the bridge cannot name a verifiable region. `runComposerSend` then does the destructive `ctrl+k` / Backspace sweep **unbound** into a live `/` or `/model` popup.

## Do

Pick **one** (smaller is better):

**A.** Peel the popup so `composerPrompt` still names the `→` row inside the tail window (bindable region), **or**

**B.** Refuse `onComposerSeen` (no sweep) while `findAutocompleteRun` is non-null.

Then put those fixtures back in the agreement suite.

Prefer B if peeling the popup would send keys into the list. Prefer A if the `→` row is a stable bind region the bridge already 409s on.

## Do not

- Invent digits for the popup (ADR 0009).
- Leave AUTOCOMPLETE excluded “until later”.
- Change Agy trust (row 05) or prompt-binding shared matcher (row 06) except to include these fixtures in conformance once bindable/refused.

## Files

| File | Change |
|---|---|
| `web/src/lib/harness/cursor/chrome.ts` | `composerPrompt` and/or ready+autocomplete |
| `web/src/lib/harness/cursor/autocomplete.ts` | Only if peel/refuse lives here |
| `web/src/lib/actions.ts` or `reply-action.ts` | `onComposerSeen` refuse if B |
| `web/src/lib/harness/cursor.test.ts` | AUTOCOMPLETE back in agreement |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- Each AUTOCOMPLETE fixture: either `composerPrompt` is a non-null bindable row, or send is refused with no `ctrl+k` sweep.
- Conformance cohorts include AUTOCOMPLETE.
- A short filtered list that still fits the tail window stays bindable (existing comment).

## Done means

A send while Cursor autocomplete is open cannot clear or submit the popup with unbound `ctrl+k`. Conformance catches the next popup that grows past six rows.
