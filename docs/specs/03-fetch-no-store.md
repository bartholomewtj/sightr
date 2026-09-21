# 03 — fetch no-store / 304 without a local entry

Council row 3. Severity: high. Cadence.

## Why

`doReq` and `fetchPane` in `web/src/lib/api.ts` never set `cache: "no-store"`. `fetchPane` sends `If-None-Match` when `paneCache` has an entry; after `invalidatePaneCache` the in-memory entry is gone. iOS/Safari HTTP cache can still 304 the pre-key frame. `res.status === 304 && cached` is the only 304 success path; a 304 with no local entry falls through `!res.ok` and throws `ApiError`. The 1.0.2 150/400ms ladder then never sees the new dump; `paneLoader` keeps the old frame (flagged error).

## Do

- Set `cache: "no-store"` on every `/api` `fetch` (`doReq` and `fetchPane`, and any other fetch site that talks to the bridge).
- On 304 with no in-memory pane entry: retry once **unconditional** (no `If-None-Match`) instead of throwing `ApiError`.
- Keep the existing 304 + cached body path. Keep `invalidatePaneCache` dropping the ETag so the next read is meant to be unconditional — `no-store` makes that actually true on Safari.

## Do not

- Change bridge ETag generation or shell bust-ladder timing except if a test needs a documented header.
- Change service-worker update (row 10) or journal history ETag (row 09).
- Set `cache: "reload"` only on pane reads and leave other `/api` fetches cacheable.

## Files

| File | Change |
|---|---|
| `web/src/lib/api.ts` | `cache: "no-store"`; 304-without-cache retry |
| `web/src/lib/api.test.ts` | 304 with no cache → retry; 304 with cache → body |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- `fetchPane` after `invalidatePaneCache`: first response 304 with no body → second request has no `If-None-Match` and returns JSON.
- `fetchPane` with cache hit 304: no second request; returns cached body; `notModified: true`.
- `doReq` GET includes `cache: "no-store"`.
- Existing prompt-changed 409 recover path unchanged.

## Done means

Post-key / post-tap pane reads hit the bridge. The shell ladder can see the new frame instead of a Safari 304 of the pre-key dump.
