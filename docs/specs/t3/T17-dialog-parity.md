# T17 — Dialog parity: multi-select, wizard and preview-select requests

Status: done on feat/v2 (2026-10-17)

Depends on: T04 (runtime requests, `respond`), T05 (command endpoint), T12 (`RequestPanel`). Read `README.md` in this folder first.

## Problem

T04 turns single-choice dialogs into runtime requests. Three dialog shapes that v1 answers from the phone are left
to the Terminal tab: multi-select (checkbox asks on Claude, Grok and Cursor), wizard (multi-question asks with a
stepper, on Claude and Pi) and preview-select (Claude's preview variant).

The data is cheap. v1's adapters already lift all three into neutral models
(`web/src/lib/harness/multi-select-model.ts`, `wizard-model.ts`, `preview-model.ts`), and `dialog-contract.ts` gives
each kind its comparators and the literal `region` text for prompt binding.

Answering is not cheap. v1 answers two of them with closed-loop recipes in the browser
(`lib/preview-action.ts`, `lib/multi-select-action.ts`, both over `lib/dialog-guard.ts`). A preview digit only moves the
pointer, so the recipe re-reads and then sends Enter. A multi-select Submit is a pointer walk that is verified before
Enter. Those modules import `api.ts`, so the bridge cannot call them. T04's `respond` sends one key list after one
binding check, which does not fit.

## Change

### Parse (`web/src/lib/harness/dialog-kit.ts`, T04's leaf)

- `parseDialog` also returns the three shapes, from each adapter's existing detector (Claude `multi-select`, `wizard`,
  `preview-select`; Grok and Cursor multi-select; Pi wizard). The leaf rule and the per-fixture pin are as in T04.
- For these shapes `boundText` is the model's `region` from `DIALOG_CONTRACT`, the literal text on screen, not T04's
  12-line tail.
- Request fields. T01 lists them as optional on `RuntimeRequest`; all three shapes publish `kind: "question"`.
  - `steps?: { label, answered, current }[]`: the wizard stepper chips. Also set on a preview or multi-select question
    that is one step of a wizard.
  - `multiSelect?: { checked: boolean[]; advanceLabel: string }`: the checkbox state per option, and the terminal's own
    `Submit` or `Next` label.
  - `preview?: string[]`: the pointed option's preview pane. Only that option's preview is on screen.
  - `answers?: { question, answer }[]`: the echoed answers on a wizard or multi-select review step.
  - `options[]` as T04, plus `description?`. A wizard question option's `keys` is the model's own (the digit alone on
    Claude). A review step has two options, Submit and Cancel, with the model's submit and cancel keys. "Chat about
    this" rows are options with `destructive: true`, because they abort the ask.
- Each wizard step and each review screen is a new request (its binding hash changes). The client answers one step
  at a time.

### Respond (`bridge/threads/respond.ts`)

- **Wizard** question and review steps: T04's `runtime-request.respond {requestId, optionIndex}`, unchanged.
- **Preview-select:** `respond {requestId, optionIndex}` runs the preview recipe: send the digit, re-read, check that the
  pointer is on that option and `previewCoreEqual` still holds, then send Enter. A failed check sends nothing more and
  rejects with `prompt-changed`.
- **Multi-select** checkbox step: `respond {requestId, optionIndices: number[]}` (the addition T01 lists). The bridge
  toggles each option whose checked state differs from the wanted set, re-reading after each toggle and comparing with
  `multiSelectIdentity`. It then runs the submit walk for the dialog's `recipe`: Claude's Down-to-bottom, Up once,
  verify the pointer is on the advance row, Enter; Grok's `tab-space-enter`; Cursor's `pointer-space-s`. Any drift
  aborts before Enter with `prompt-changed`. `optionIndices` on any other request is `invalid`.
- **Shared recipes.** Move the recipe algorithms out of `preview-action.ts` and `multi-select-action.ts` into a leaf,
  `web/src/lib/dialog-recipes.ts`, with the I/O injected (`read()`, `sendKeys(keys)`, `sleep`). This is how spec 24
  moved the guarded send into `guarded-send.ts`. v1's action modules call it with the browser I/O, and the bridge calls
  it with `herdr.readPane(paneId, "visible", 60, "ansi")` and `sendKeysPaced`. v1's behaviour does not change.
- One `respond` holds the pane-queue turn for the whole recipe. The recipe's reads are bounded by v1's poll counts.

### RequestPanel (web2, T12)

- **Multi-select:** a checkbox per option from `multiSelect.checked` and one button labelled `advanceLabel`. The UI
  keeps the wanted set until the tap, then posts `optionIndices`. A new request (the screen changed) resets the set
  from the fresh `checked`.
- **Wizard:** the stepper chips from `steps` above the question (copy `web/src/components/wizard-stepper.tsx`). A review
  step lists `answers` and shows Submit and Cancel.
- **Preview:** the preview lines in a Consolas block under the pointed option.
- "Chat about this" keeps T12's destructive rule: warn tokens and a second tap.

## Not in this slice

- Free-text rows: Claude's plan feedback, Pi's type-in row and the preview note (`n`). They type text into the pane,
  and the Terminal tab handles them.
- Wizard Back and Next (Left/Right). Answering moves forward; going back is done in the Terminal tab.

## Invariants

- Every key of a recipe follows a fresh `visible` read that passed the kind's comparator from `DIALOG_CONTRACT`. A
  mismatch sends nothing more.
- No multi-select Enter goes out until the pointer is verified on the advance row.
- A recipe runs inside one pane-queue turn.
- The v1 dialog actions behave as before the extraction.

## Tests

- **dialog-kit:** each fixture of the three shapes gives the expected fields; pinned to the adapter's detector as in T04.
- **Recipes** (pure, fake read and send): preview verifies the pointer before Enter; a pointer that did not move aborts;
  multi-select toggles only the differing boxes; a box flipped by another device aborts before Enter; each of the three
  submit recipes.
- **Respond:** wizard step by digit; review Submit; `optionIndices` on a permission request is `invalid`; a stale screen
  gives `prompt-changed` and no Enter.
- **v1 regression:** the existing `multi-select-action`, `preview-action` and `wizard-action` tests pass unchanged.
- **RequestPanel:** checkboxes post the wanted set; stepper renders; review lists answers; preview sits under the
  pointed option; "Chat about this" needs two taps.
- **Live** (scratch workspace): one Claude multi-select, one wizard and one preview ask answered from web2.

## Notes for the planner

- The parse side is small; the recipe extraction is most of the work. If it grows, ship wizard (no recipe needed) and
  preview-select first, and leave multi-select to a follow-up.
- `preview` holds only the pointed option's pane because the TUI draws only that one. Showing every option's preview
  would mean moving the pointer, which is a write.

## Built

- **Recipes leaf.** `web/src/lib/dialog-recipes.ts` holds `pollModel` (v1's `pollUntil` body), `previewSelectRecipe`,
  `multiSelectAdvanceRecipe` (Claude's walk), `tabSpaceToggleRecipe`, `pointerWalkRecipe` and, for the bridge,
  `multiSelectApplyRecipe` (toggle the differing boxes, verify each flip, then submit) and `tabSpaceSubmitRecipe`.
  I/O is `{ read, send(keys, region?), sleep }`. v1's `multi-select-action.ts`, `preview-action.ts` and
  `harness/guard.ts` call it; their tests pass unchanged. Its import test pins it to the model modules.
- **Shapes (deviation).** `preview` is `{ optionIndex, lines }`, not `string[]`: the panel has to know which option
  the pane belongs to. The contract's placeholder T17 fields are replaced by the spec's (`steps: RuntimeRequestStep[]`,
  `multiSelect {checked, advanceLabel}`, `answers [{question, answer}]`). The shell summary also drops `preview`.
- **T3 mirror.** `shared/v2/request-question.ts` maps a question request to T3's `OrchestrationV2UserInputQuestion`;
  the bridge's `user_input_request` item and the web2 panel both use it. One request is one question: id `q<n>` and
  header from the current stepper chip (`review` / `Review` on a review), `multiSelect: true` with only the boxes
  as options, and each option's `value` is its index in `request.options`. `UserInputQuestion.options` is now
  `readonly`, as T3's schema type is.
- **Parse.** For wizard, checkbox and preview dialogs `boundText` is the model's normalized region (often more
  than 12 lines). Claude's checkbox options carry the digit; Grok and Cursor boxes carry no keys (the recipe
  walks). A wizard's escape row and both review Cancels are `destructive` (two taps): a review's Cancel aborts
  like a menu's cancel. Pi's review offers no Submit while `submitKeys` is null. Pi's open editor and Claude's
  focused preview note publish no options. `dialogModel(agent, text, kind)` and `dialogRegion` are exported for
  the bridge.
- **Respond.** After T04's binding check, a recipe request re-reads, parses through the thread's adapter, and
  needs the fresh region to equal the stored `boundText`; that read stands in for binding the first write (v1
  binds the first write instead). Codes: `optionIndices` on a non-checkbox request `not-multi-select`, a box
  answered by `optionIndex` `use-option-indices`, both fields `both-answers`, bad or repeated indices
  `bad-option`. "Chat about this" on a checkbox step is a plain `optionIndex`. A recipe that sees another screen
  expires the request (as T04's stale path) and answers `prompt-changed`. Grok's submit reads and checks identity
  before its Enter (v1 sends Enter right after its entry guard). The audit line carries every key sent and the
  recipe name. Resolved requests store `optionIndices` sorted.
- **web2.** `ComposerPendingUserInputPanel.tsx` follows T3's panel: keyed by request, T3's `pendingUserInput.ts`
  (adopted, `projectPendingUserInputAnswer` left out) holds the draft, single choice shows its check and answers
  200 ms later, checkbox taps (and 1–9) toggle a draft seeded from `multiSelect.checked`, and a button labelled
  `advanceLabel` posts `optionIndices` (it needs one box, as T3's `canAdvance` does). Not taken from T3: the
  collapse toggle, dismiss, and markdown for the question (terminal text). The stepper is
  `ComposerPendingUserInputStepper.tsx`, read-only (no Back/Next, as the spec's "Not in this slice" says).
  `respondToRequest` takes an option index or an index list; `RESPONDING_ADVANCE` (-1) marks the advance button
  busy. `ChatComposer.tsx` is unchanged.
- **Live (Claude Code 2.1.301, Haiku, scratch workspace).** Answered from web2: a single-question checkbox ask
  (two boxes, Submit, then the review's Submit), a two-question wizard (a single-choice step, then a checkbox step
  whose advance read Submit, then the review), and a preview select (moved from the first option to the second).
  A Claude digit toggles its box without moving the pointer, so the Submit walk starts from wherever the pointer
  was. Not live-checked: Grok and Cursor checkbox recipes, Pi wizards (fixtures and fakes only).
- **Known.** The composer's "Sent to the agent." verdict from one answer stays under the next request's card
  (T12 composer state; ChatComposer clears `responding` on a new request but not `verdict`).

