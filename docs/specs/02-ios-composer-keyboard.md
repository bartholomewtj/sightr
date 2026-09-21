# 02 — iOS composer keyboard

Council row 2. Severity: high. Phone.

## Why

The composer cluster (`Composer` in `web/src/components/composer.tsx`) sits at the bottom of a `h-[100dvh]` column (`RootLayout`) whose phone outlet is `overflow-hidden`. Unlike `ComposerMenu.readVisibleViewport` / `bottomInset` (`web/src/components/composer-menu.tsx`), the composer never reads `visualViewport`. `index.html`’s `interactive-widget=resizes-content` is ignored by iOS Safari/PWA, so dictation, Send, and `YesNoStrip` land under the keyboard. Phone `onInputKeyDown` already bails before Enter-to-send (`use-composer-state.ts`) — keep that. There is no `enterKeyHint` on the field.

## Do

- Reuse `readVisibleViewport` / `bottomInset` on the composer cluster (same lift as the More sheet). When `bottomInset` is non-zero, zero `env(safe-area-inset-bottom)` on that cluster so home-indicator padding is not stacked on the keyboard.
- Keep Enter as newline on phone so dictation still works once Send is actually on-screen.
- Optional: `enterKeyHint="send"` only if it does **not** make iOS treat Enter as submit. If it fights dictation/newline, omit it and say so in the Unreleased note.

## Do not

- Change desktop layout or `html.sightr-desktop` overflow (that is row 21).
- Implement pull-to-refresh (row 21) or notch double-padding (row 22).
- Change `showYesNo` / wheel placement (row 01) except to keep the lifted cluster containing those controls.
- Add a third viewport helper. Extract or import the existing one.

## Files

| File | Change |
|---|---|
| `web/src/components/composer-menu.tsx` | Export `readVisibleViewport` (or a shared tiny helper) |
| `web/src/components/composer.tsx` | Apply bottom inset to the cluster |
| `web/src/routes/root.tsx` | Only if the column must yield height to the inset |
| Colocated tests | Mock `visualViewport` height/offsetTop |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- With `visualViewport` shorter than `layoutViewport` by N px, the composer cluster’s bottom padding/translate equals N (or `max(N, 0)`).
- When `visualViewport` matches layout, no extra inset (home indicator / `safe-area-inset-bottom` unchanged).
- Phone Enter still inserts newline (existing composer keydown tests).

## Done means

After one-handed dictate or tap-to-type on iOS PWA, the draft and Send (and Yes/No if shown) sit above the keyboard.
