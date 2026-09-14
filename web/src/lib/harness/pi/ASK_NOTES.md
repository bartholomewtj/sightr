# Pi `askuserquestion` Notes

## Source Facts & Architecture
Source: `~/.pi/agent/extensions/ask.ts` (tool implementation) and `@earendil-works/pi-coding-agent` 0.85.1 (`dist/modes/interactive/components/footer.js`).

1. **Rendering (`ask.ts` ~317–430):**
   `createQuestionnaireUI(...).render(width)` pushes:
   - An accent rule (`─`.repeat(width)).
   - *Multi only:* tab bar (`addWrappedWithPrefix(" ", ...)`): `← ` + ` □ Label ` / ` ■ Label ` + ` ✓ Submit ` + ` →`.
     The current tab chip is highlighted with `theme.bg("selectedBg", ...)` — background colour only, no distinct text marker. Followed by a blank row.
   - *Question view:* prompt (prefixed with `" "`, wraps), a blank row, then options:
     - Active option has pointer `> N. label`.
     - Other options have indent `  N. label`.
     - Wrapped label continues with 2-space indent.
     - Optional description wraps with 5-space indent.
     - The last option is always `N. Type something.` (`allowOther: true`).
   - A blank row, then help row:
     - 1Q: ` ↑↓ navigate • Enter select • Esc cancel`.
     - Multi: ` Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel`.
   - A closing accent rule (`─`.repeat(width)).
2. **Key handling (`ask.ts` ~233–310):**
   - Up/Down move `optionIndex` (clamped, no wrap).
   - Enter on a standard option saves the answer (submitting in 1Q, or advancing to next tab/Submit in multi).
   - Enter on `Type something.` enters custom input mode (`inputMode = true`).
   - Esc cancels the questionnaire.
   - Multi: Tab/Right advance to next tab (wrapping modulo), Shift+Tab/Left move back.
   - Submit tab: Enter submits only when all questions are answered.
   - **Digits are completely unhandled** in `handleInput` — Pi ignores digits entirely. Digits must NEVER be sent (ADR 0009).
3. **Screen layout & Footer:**
   On a live pane, the ask frame sits in the editor slot (`ctx.ui.custom`).
   Below the closing rule sit 2 or 3 footer rows:
   - PWD row (e.g. `~/Projects/tools/sighter (fix/366-pi-ask-lift)`).
   - Stats row containing context usage token stats: `NN.N%/<window>` or `?/<window>` (e.g. `↑1.5k ↓3.4k 4.1%/200k (auto)  muse-spark-1.3 • medium`).
   - Optional extension status row.
   The detector allows 0, 2, or 3 footer rows below the closing rule, and requires the second to match the stats pattern when footer rows are present.

## Live Observations (2026-09-13)
- Observations during interactive questionnaire:
  - Live 2026-09-13 lines match Pi's `render()` output character for character:
    - `" ←  □ Color   □ Size   ✓ Submit  →"`
    - `"↑↓ navigate • Enter select • Esc cancel"`
    - `" Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"`
  - During live execution Herdr reported `screen_detection_skipped` / `working`.

## Keystroke Recipe
- Options are activated by walking the pointer with Up or Down arrows from the active pointer `>` row, followed by `Enter`.
  For example, with pointer at row 0 (Option 1):
  - Option 1 sends `["Enter"]`
  - Option 2 sends `["Down", "Enter"]`
  - Option 3 sends `["Down", "Down", "Enter"]`
- `keyLabel` is set to `String(i + 1)` so the UI displays the option number badge even though arrow keys are transmitted.
- Digits are NEVER emitted.

## "Type something." Free-Text Lock
- Option `N. Type something.` is not exposed as a tappable option.
- When the pointer is on `Type something.`, `feedback.focused` is `true`.
- Tapping buttons while focused is refused (`submitPromptOption` refuses with `{ status: "changed" }`), preventing invalid keystroke execution while free-text input is active.

## What is NOT Lifted
- **Submit tab:** The review tab (`Ready to submit`) has no options and uses Enter to submit rather than standard wizard submit keys (`["1"]`). It stays raw in the terminal mirror.
- **Input mode:** When input mode is active (Enter pressed on `Type something.`), the options remain for reference and `Your answer:` / editor appears. The frame stays raw and is not lifted into buttons.

## Fixture Provenance
- `web/src/fixtures/panes/pi--ask-*.txt` were generated using Pi's own `createQuestionnaireUI(...).render(94)` via `jiti` import from `C:/Users/barth/.pi/agent/extensions/ask.ts`.
- Upstream header rows 1–2 (`── ⠴ Working ──` and blank row) were prepended from `upstream/main:web/src/fixtures/panes/pi--v085-working-editor.txt`.
- Footer rows (PWD and token stats) were appended to represent the full live pane layout.
- These are rendered output + spliced headers/footers, not live captures. They should be replaced by live captures when an interactive Herdr session is captured.

## Unprobed (Verify on Next Live Pane)
- Batch delivery of multiple arrow keys plus Enter in a single `send_keys` array (the live manual pass sent arrows individually).
- Exact spacing and blank-row layout between the ask frame and footer rows across different terminal heights.
- Real terminal theme `selectedBg` RGB values in live environment.

## Known Limitations
- After pressing Enter on `Type something.` to enter input mode, the screen remains raw mirror text and the phone composer behaves as an ordinary terminal keyboard.
