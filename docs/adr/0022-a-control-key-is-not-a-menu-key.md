# 0022 — A control key is not a menu key

Status: **Accepted** (2026-08-17)

## Context

[ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) accepted "only keys the screen printed" as the generic menu contract, and `menuKeyFor` whitelisted `ctrl+<letter>` on that basis. The trust argument was that a screen naming its own keys is the one thing about an unknown modal we can trust.

However, **the label and the key are parsed from the same agent-written text**. An agent printing `ctrl+c to Continue` gets a button labelled "Continue" that sends `ctrl+c`.

The load-bearing distinction between control keys and every other key hint:
- **In-band keys (`Enter`, `s`, `Tab`, `Esc`, arrows, letters):** Consumed by whatever modal is reading the terminal. The worst case of a deceitful or confused screen is the wrong answer to a visible dialog question.
- **Out-of-band control keys (`ctrl+c`, `ctrl+d`, `ctrl+z`):** Escape the modal entirely and reach the harness's signal handling—interrupt, EOF, or suspend. They do not answer the dialog; they act destructively on the session hosting it.

The exposure is same-pane only: an agent can only disrupt its own run, which is why severity is Low rather than an escalation. No shipped fixture emits a control key in a generic menu footer, so this closes a live-screen path rather than fixing an observed regression.

## Decision

1. **A generically-detected menu emits only in-band keys the screen printed, plus arrows it advertised.** Control keys (`ctrl+<letter>`) are excluded even when the screen names them in its footer.
2. **The ban lives in `menuKeyFor`, not in `isValidHerdrKey`.** `ctrl+c`, `ctrl+k`, etc. remain valid Herdr wire keys, which features like `preview-action.ts` and `nav-tray.tsx` legitimately depend on.
3. **Operator-composed control keys are untouched.** The Keys dock and `nav-tray.tsx` presets are chosen by the operator, not parsed from agent output.

## Consequences

- An unrecognised modal printing e.g. `ctrl+g to edit in nano` will not get a synthesised button. The raw terminal mirror and the Keys dock still drive it, which ADR 0009 already accepted as the standard fallback.
- `conformance.ts:472` enforces this invariant across all present and future harness adapters.
- Revisit if Herdr ever exposes structured menu state from the agent rather than screen-scraped text.