# 09 — History paging must not duplicate the tail

Council row 9. Severity: high. Journal + cadence.

## Why

`pageEntries` in `bridge/journal/store.ts` treats an unknown `before` cursor as the newest page (`i === -1 ? entries.length : i`). The comment says this is deliberate so history is never empty. `useInlineHistory.loadOlder` does `setEntries(prev => [...res.entries, ...prev])` with no uuid dedupe. A rewritten log, Claude `followContinuation` file switch, or Cursor `cursor-${seq}` id shift prepends the current tail onto the turns already on screen.

`useInlineHistory` refetches 160 turns every `INLINE_REFRESH_MS` (1500) with no ETag while the pane is open. `refreshNewest` holds `loadingRef`, so `growUpward` is a no-op for the whole GET.

Existing test: `an unknown cursor degrades to the newest page, never to empty` — **replace that contract**.

## Do

- On a missing `before` cursor: return `{ window: [], hasMore: false }` (or `{ window: [], hasMore: false, reset: true }` if the client must replace). Do **not** return the newest page.
- On the client: ignore or replace when the older page overlaps the held newest uuids. Never concatenate a page that includes uuids already in `entries`.
- Add pane-history ETag/304 like `fetchPane` (row 03’s `no-store` still applies to `/api` fetches).
- `refreshNewest` must not take the grow lock for the whole GET. `growUpward` / `loadOlder` can run during a refresh.
- While the pane is idle/done, tick at `COLD_MS` / `pollIdleMs` (or the snapshot idle cadence). Keep the status-flip + `INLINE_IDLE_RETRY_MS` path.

## Do not

- Change prefetch 160 on first open.
- Change beacon session rules (row 07) or Grok WEAK (row 08).
- Return empty for a **known** cursor with no older rows (`hasMore: false` with empty window is correct there too).

## Files

| File | Change |
|---|---|
| `bridge/journal/store.ts` | `pageEntries` unknown cursor |
| `bridge/journal/store.test.ts` | Flip the “gone” cursor test |
| History route if it wraps `pageEntries` | Pass through empty/reset |
| `web/src/hooks/use-inline-history.ts` | Dedupe; ETag; lock; idle cadence |
| `web/src/hooks/use-inline-history.test.ts` | Overlap prepend; refresh vs grow |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- `before: "gone"` → `{ window: [], hasMore: false }`, not `e4,e5`.
- Known `before: "e4"` still returns `e2,e3`.
- Client: older page whose uuids overlap held newest does not duplicate.
- Refresh in flight does not make `loadOlder` a no-op.
- Idle pane: refresh interval longer than 1500ms (assert the constant used).

## Done means

Swipe-up paging cannot splice two windows of the same recent turns into one thread. Idle open-pane radio drops without hiding new jsonl rows.
