# Cursor ask-question card — keystroke recipe & architecture

Observed 2026-09-13 on Cursor Agent in pane `wDX:p9`. Sighter showed user bubble only; Herdr reported status `done`. Terminal displayed the raw box.

```
Cursor ask
Question 1 of 1
1. Which fruit should the test pick?
  › [ ] Apple
    [ ] Banana
    [ ] Cherry
    [ ] Other: (type to answer)
↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip
```

## Source ground truth

Source file: `C:\Users\you\AppData\Local\cursor-agent\versions\2026.09.10-fd3934a\3484.index.js`.
Components:
- `./src/components/ask-question-form.tsx` (`AskQuestionForm`): paints cyan single-border box (`┌─┐ │ └─┘`) at screen width − 2 inside `paddingX:1`, column `paddingX:1, gap:1` (title, `Question k of n`, `${k}. ${prompt}` with optional ` (multi-select)`, option rows with `marginLeft:2`, and the footer).
- `./src/utils/interaction-utils.ts` (`Q7`): option rows, always appending freeform row `__freeform_other__` (`Other: (type to answer)` / `Other: <text>`).
- Key handler: prompt-input `useInput` hook (`if(_t){...}`).

## Key table

| Key | Effect |
|---|---|
| Up/Down | move the pointer, clamped (no wrap) |
| Enter | select the pointed row, then next question or submit |
| Space | select without advancing; toggle on multi-select |
| Left/Right | change question (resets pointer to row 0) |
| `s` | submit the whole ask immediately — **never sent** |
| `k` / Esc | skip the ask — **never sent** |
| printable, Space, Backspace on `Other` | type into the free-text field |

Digits on an option row do nothing.

## What the adapter lifts

- Single-select questions (`Question k of n` without `(multi-select)`) lift into `prompt-select`.
- Keystroke recipe: from `›` pointer row `p` to target row `i`, send `|i - p|` × (`Down` if `i > p` else `Up`), followed by `Enter`.
- On a 1-of-1 card, Enter selects and submits. On a `k` of `n` (`n > 1`) card, Enter selects and advances to question `k + 1`. On the last question, Enter submits only when all questions are answered.
- `Other:` is modelled as `free-text` feedback (`feedback.purpose = "free-text"`). When Cursor's pointer is on `Other:`, `feedback.focused` is true and the UI buttons lock. Nothing is typed from the phone.

## Multi-select (live 2026-09-27, v2026.09.26-dd393fe)

Cards whose question ends ` (multi-select)` lift as `multi-select`, recipe `pointer-space-s`.
Probed on pane `wGK:p5` (fixtures `cursor--ask-multi-*.txt`):

- Keys must go one per write. `[Down, Down, Space]` in one `send_keys` moved the pointer once and
  dropped the rest; single-key writes 300ms apart all landed. The bridge now paces every `/keys`
  recipe (`sendKeysPaced`), which also fixes the single-select arrow walk.
- Space toggles the `›` row. Enter on a checked pointed row submitted the set unchanged; Enter on an
  unchecked row ADDED it (and advanced to the next question). Enter is never the submit key.
- `s` submitted every question's checked set without touching the pointed row
  (`Question fruits: … banana, apple` / `Question veg: … pea`, pointer on unchecked Leek).
- Left/Right change question on a k-of-n card; the pointer resets to row 0.
- On this build the composer does not paint under the card, and Herdr reports `done`.

Toggle walks Up/Down one key per fresh read until `›` is on the row, then Space. Submit steps off
`Other:` first (`s` would type there), then sends `s`.

## Not lifted

- Cards with any other footer or layout format fail closed.

## Composer refusal

While an ask card is displayed (`askCardPresent`), the composer still paints beneath it (`→ Add a follow-up`, `Auto`, `cwd`), but the ask card owns the keyboard. `composerReady` reports false, `extractInputDraft` returns `null`, and `extractStatusLines` returns `[]` so phone typing cannot accidentally fire shortcut keys like `s` (submit) or `k` (skip).

## Fixture provenance

The fixtures `cursor--ask-fruit.txt` and `cursor--ask-fruit-other-focused.txt` are **composed**:
- Card text programmatically copied from the `specs/issue-370_cursor-ask-lift.md` spec;
- Laid out with borders and column widths per Cursor's installed source;
- Combined with transcript rows 1–46 and composer rows 50–54 from `cursor--done.txt`.

They are not byte-faithful dumps and should be replaced by a live `wDX:p9`-shape dump when a pane is available. Two layout details are unverified: the single blank row between card and composer, and whether the composer paints at all.

## Pending live probe

Live capture was waived for this pass. The keystroke recipe and component behavior are verified against installed source, but the following remain pending a live probe:
- ~~A multi-arrow + Enter batch in one `send_keys`~~ — probed 2026-09-27: it drops keys; the bridge paces them;
- The blank-row / composer layout under the card;
- Live Herdr status while an ask is up;
- That Enter on a 1-of-1 card submits (live 2026-09-27: picking row 3 from the phone submitted `large`).
