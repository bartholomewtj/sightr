# Grok plan approval — keystroke recipe

Captured 2026-08-21 on Grok Build 1.0.5 (`/plan Add a one-line NOTICE file…`).
The plan preview is a rounded `╭─ plan.md` box **above** a still-visible composer
whose empty prompt paints the placeholder `Build anything`. Status in the bottom
border: `· plan approval`. Hint row under the box:

```
c:comment  │  y:copy plan  │  a:approve  │  q:quit plan  │  v:select  │  Tab:prompt
```

xAI documents the same letters ([Plan Mode](https://docs.x.ai/build/features/plan-mode)):
`a` approve, `s` request changes, `c` comment, `q` quit. `s` is on the inner
hint bar, not the tail footer, so the generic lift uses the **tail footer only**.

Live-probed: `q` dismissed the review. `Tab` and `s` both focus the composer (placeholder
cleared); the footer becomes `a:approve │ Tab:plan │ Esc:back` — no `q:quit plan`. Esc
returns to the idle review footer. `s` is "type a change request", not a one-shot.

`composerReady` is false while the review owns the keyboard (`q:quit plan` footer). Once Tab/`s`
focus the composer (`… │ Tab:plan │ Esc:back`), the keyboard is the draft's: the menu is NOT
lifted there and the adapter reads the composer like any other, so a phone reply types, verifies
and sends the change request with Enter. Live 2026-09-27 (fixture `grok--plan-focused-draft.txt`):
with the menu still lifted in that state, a phone reply was refused as "a dialog is waiting" and a
forced one typed but stalled unverified. Approve is one Esc away (keys tray / wheel).

On the phone the review's `Tab:prompt` is labelled "Request changes", and `v:select` (a terminal
text-selection mode) is not offered.

The race-guard **signature** is the whole preview (plan.md box + composer + footer) so a
swapped plan is refused. The **bound region** (`expected_prompt`) is only the composer box
and the hint footer — a real plan fills the viewport and the full signature is past the
bridge's 8192-character cap, which 400s the tap as `bad expected_prompt` and types nothing.
