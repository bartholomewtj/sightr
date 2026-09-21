# 14 — Find close re-follows; shells freeze too

Council row 14. Severity: medium. Cadence.

## Why

`closeFind` in `web/src/hooks/use-pane-view.ts` only `setFindOpen(false)` and clears the query. It never `setFollowing(true)` / `scrollToBottom`. `hasNew` is `!following && display !== text`. The adopt effect skips freeze only when `findOpen && !shellMirror`, so agent panes freeze during Find but **shell** dumps (draftr / win-terminal-browser) keep replacing `{text, revision}` and jump the match. After closing Find on an agent pane, `findOpen` is false so `shown` tracks live `text` — `hasNew` is then unreachable (`display === text`) while `following` is still false from `openFind` / `gotoMatch`. You sit at the match `scrollTop` on a replacing dump with an undotted jump chip.

`openFind` / `gotoMatch` already `setFollowing(false)`.

## Do

- On `closeFind`, re-follow the tail (`setFollowing(true)` and scroll to bottom), **or** define `hasNew` as `!following` so the jump chip is honest. Prefer re-follow: Find is a temporary pin.
- Freeze the `{text, revision}` pair for shells too while Find is open (drop `&& !shellMirror` from the adopt skip, or invert so both kinds freeze).
- Keep `bustShellMirrorAndRevalidate` only when Find is **closed**. Keys must still unstick the mirror after close.
- Stop using `setFollowing(false)` in `openFind` as the freeze mechanism if `findOpen` already pins `shown`; following can stay false for scroll-into-view during Find without being the dump freeze.

## Do not

- Change snapshot poll cadence or ETag (rows 03, 09, 10).
- Freeze the dump while Type/Direct is armed (pane-live: freeze is Find-only).
- Add a new Find UI.

## Files

| File | Change |
|---|---|
| `web/src/hooks/use-pane-view.ts` | `closeFind`; adopt effect; `hasNew` |
| `web/src/hooks/use-pane-view.ts` tests or pane-view tests | Find close follow; shell freeze |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- Agent pane: open Find → `shown` pinned while `text` changes; close Find → following true (or jump chip visible if you chose `hasNew = !following` without auto follow — pick one and test it).
- Shell pane: open Find → `{text, revision}` frozen across dump polls; close Find → live again.
- `gotoMatch` still does not fight live re-pin while Find is open.

## Done means

Closing Find returns a live tail (or a dotted jump-to-latest). Find on a live TUI pane keeps a stable buffer. Keys still unstick the shell mirror after close.
