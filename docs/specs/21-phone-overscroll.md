# 21 — Phone shell lock and in-app pull-to-refresh

> **Rewritten 2026-09-28 (`88a6328`).** Bart's call: stop the browser reload, and give both the pane
> and Spaces an in-app pull-to-refresh. This version replaces the stale 21 Sep draft. That draft
> cited "GitHub #16", which is the whistlr-31f PR, not an issue. Nothing has been built yet.

Council row 21. Severity: medium. Phone only.

## Why

On the phone, a pull-down at the top of the pane or of Spaces can trigger the browser's own
pull-to-refresh. That reloads the whole PWA, even in the middle of a needs-you card. Code as of `88a6328`:

- `web/src/index.css`: `body` has `overscroll-behavior-y: none`, but only `html.sightr-desktop`
  gets the `height: 100dvh; overflow: hidden` frame. The phone document itself can still scroll.
- `web/src/components/ui/chat/chat-message-list.tsx`: the pane scroller is `overflow-y-auto` with no
  `overscroll-contain`.
- `web/src/routes/tree.tsx`: the Spaces scroller already has `overscroll-contain`, but it has no
  refresh gesture.
- `web/src/components/ui/sheet.tsx`: `BottomSheet` already calls `preventDefault` on a top-of-sheet
  touchmove, for the same reason ("a pull-down at the top would reload the whole app").

## Do

1. **Lock the phone shell.** Give phone mode the same fixed frame as desktop (`html, body, #root`:
   `height: 100dvh; overflow: hidden`). Use either a phone class or an unconditional rule, whichever
   leaves desktop unchanged. Only the inner scrollers should scroll.
2. **Contain the pane scroller.** Add `overscroll-behavior-y: contain` to the element that actually
   scrolls in `ChatMessageList`. Keep the one on the Spaces scroller.
3. **Add in-app pull-to-refresh on the pane and on Spaces.** Engage only when the gesture starts at
   `scrollTop === 0` and moves down past a threshold (about 60–80 px, the same slop idea as
   `BottomSheet`). Show a small pull indicator.
   - On release it calls the route's `useRevalidator().revalidate()`. That is the path the pane
     (`hooks/use-pane-view.ts`) and Spaces (`routes/tree.tsx`) already use. Never call
     `location.reload()`.
   - One shared hook or component for both scrollers, not two copies.
   - A pull must not also start the pane's "load older history" grow. Pull-to-refresh only
     revalidates at the current line count.
4. A short permission card, where the pane content does not fill the screen, must refresh in place
   on a pull. It must never reload the app.

## Do not

- Build the iOS keyboard inset (row 02). It touches the same shell, so do not regress it if it has
  shipped by then.
- Hard-refresh as the pull action. That fights row 10's service-worker swap.
- Change desktop: the sidebar scroll, the desktop frame, and mouse wheel behaviour all stay as they are.
- Add pull-to-refresh inside sheets (`BottomSheet` keeps its drag-to-dismiss).

## Files

| File | Change |
|---|---|
| `web/src/index.css` | Phone shell lock |
| `web/src/components/ui/chat/chat-message-list.tsx` | `overscroll-contain`; wire the pull |
| `web/src/routes/tree.tsx` | Wire the pull on the Spaces scroller |
| New `web/src/hooks/use-pull-to-refresh.ts` (or a small component) | The shared gesture + indicator |
| Tests beside each | See below |
| `CHANGELOG.md` | Unreleased: Added (pull-to-refresh) / Fixed (pull no longer reloads the PWA) |

## Tests

- The phone document and root do not scroll (the lock class or style is present in phone mode;
  desktop is unchanged).
- The pane scroller has `overscroll-behavior-y: contain`, and the Spaces scroller keeps it.
- A simulated pull at the top of the pane scroller calls `revalidate()` once and never `reload`.
  The same holds for Spaces.
- A pull that starts below the top, or one shorter than the threshold, does nothing.
- A pull does not call the load-older path (`growRequestedLines`).

## Check (Bart's call: Android/CDP is enough)

Unit tests, then a live phone-emulation pass with ca + CDP. The recipe is in the 27 Sep harness-review
memory. Use a scratch herdr workspace, and never touch panes you did not create.
- Open a short-card pane and pull down at the top. The herd refreshes in place and the page does not reload.
- Do the same on Spaces.
- A normal scroll back through a long pane still works, and so does load-older.

iOS rubber-band behaviour stays unverified until an iPhone is available (with specs 02 and 03). Say
so in the PR and the index row. It does not block marking 21 done.

## Done means

A one-handed pull on a short permission card, or on Spaces, refreshes the herd in place. It never
wipes the PWA in the middle of a needs-you card.
