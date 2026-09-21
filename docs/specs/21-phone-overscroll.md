# 21 — Phone shell lock and in-app pull-to-refresh

Council row 21. Severity: medium. Phone. GitHub #16 (web half).

## Why

Only `html.sightr-desktop` is locked to `height: 100dvh; overflow: hidden` (`web/src/index.css`). The phone document is free. `ChatMessageList` is `overflow-y-auto` with no `overscroll-contain` (unlike `TreeRoute`). `BottomSheet` already `preventDefault`s touchmove because a top-of-screen pull “would reload the whole app”. STATE.md next item 2 is phone pull-to-refresh for the web half of #16.

## Do

- Apply the desktop height/overflow lock to the phone PWA shell (`html, body, #root` in the installed/standalone case, or unconditionally if that does not break desktop — desktop already sets `html.sightr-desktop`).
- Add `overscroll-behavior-y: contain` on the pane scroller (`ChatMessageList` / the element that actually scrolls).
- Put **in-app** pull-to-refresh on that scroller (and on the spaces tree if #16 covers both). It must revalidate snapshot / pane, not call `location.reload()`.
- Browser rubber-band reload must not fire on a short permission card.

## Do not

- Implement iOS keyboard inset (row 02) except that both touch the shell; do not regress 02 if it already shipped.
- Hard-refresh as the PTR action (that fights row 10’s SW swap).
- Change desktop sidebar scroll.

## Files

| File | Change |
|---|---|
| `web/src/index.css` | Phone overflow lock |
| Pane list component / `agent-chat.tsx` | `overscroll-behavior-y: contain`; PTR |
| `web/src/routes/tree.tsx` | PTR if #16 includes Spaces |
| Tests | PTR triggers revalidation; document does not scroll |
| `CHANGELOG.md` | Unreleased Added/Fixed |

## Tests

- Phone document / root does not scroll (overflow hidden or equivalent).
- Pane scroller has `overscroll-behavior-y: contain` (class or style).
- Simulated pull at top of pane scroller calls the same revalidate path as a successful snapshot poll, not `reload`.
- Existing TreeRoute overscroll-contain remains.

## Done means

A one-handed pull on a short permission card refreshes the herd in place (or does nothing) instead of wiping the PWA mid-needs-you.
