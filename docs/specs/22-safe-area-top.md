# 22 — One notch padding on the current top edge

Council row 22. Severity: medium. Phone.

## Why

`ConnectionBanner` (`web/src/components/connection-banner.tsx`) and `AppHeader` (`web/src/components/app-header.tsx`) each apply `[padding-top:calc(env(safe-area-inset-top)+…)]`. Settings header does the same. A Tailscale blip’s in-flow reconnect/refused bar plus the pane header consume two notches. The red Retry row is `h-11` inside a “thin” bar.

## Do

- Put `safe-area-inset-top` on whichever chrome is currently the top edge: banner when mounted and visible; header when the banner is `display:none` / unmounted.
- Keep the banner row one line when Retry is shown (do not stack an `h-11` Retry inside a bar that also has notch padding and a second line of copy unless the banner **is** the only top chrome).
- Settings sticky header: same rule if a banner can sit above it.

## Do not

- Change keyboard `safe-area-inset-bottom` (row 02).
- Change `BottomSheet` top padding except if it double-counts with the banner.
- Restyle banner colours.

## Files

| File | Change |
|---|---|
| `web/src/components/connection-banner.tsx` | Notch only when it is the top edge; compact Retry |
| `web/src/components/app-header.tsx` | Notch only when banner hidden |
| `web/src/routes/settings.tsx` | Same if applicable |
| Colocated tests | One notch in the tree, not two |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- Banner visible: banner has `safe-area-inset-top`; header does not add it again.
- Banner hidden: header has `safe-area-inset-top`.
- Retry visible: banner height stays one control row + one text line max (assert no double `min-h-11` stack, or snapshot).

## Done means

On a flaky tailnet the permission buttons stay in the thumb zone instead of being pushed under the composer by a double status-bar gap.
