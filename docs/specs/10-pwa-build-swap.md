# 10 — PWA swaps on X-Sightr-Build

Council row 10. Severity: high. Cadence.

## Why

`observeServerBuild` / `X-Sightr-Build` in `web/src/lib/server-build.ts` only feed Settings `ConnectionInfo`. `__BUILD_INFO__` is baked by Vite (`web/vite.config.ts`) and never compared to the header in the app. `web/src/lib/pwa.ts` comments describe `checkForUpdate` / `forceReload` but the file only `registerSW` + a 60s `registration.update()` interval. A phone PWA keeps the precached shell until that loop (or a manual Settings refresh if one exists).

`api.ts` already `captureBuild`s every response including 304s.

## Do

- When the observed header (or SSE `build` id) ≠ `__BUILD_INFO__.id`, call `registration.update()` immediately.
- Keep unregister-then-reload **only** for a wedged precache (the existing last-resort path described in `pwa.ts` comments). Happy path: skipWaiting → activate → `controllerchange` reload.
- Implement the functions the comments already name (`checkForUpdate` / the wedged `forceReload` distinction) rather than a third reload story.
- Do not reload on first-visit initial `controllerchange` (existing `hadController` guard).

## Do not

- Change `cache: "no-store"` (row 03) except that both can land in `api.ts` independently.
- Auto-reload on every identical header repeat (`observeServerBuild` currently notifies even on repeat — compare to last seen **app** id, not “any observation”).
- Touch the service-worker generate config except if skipWaiting is not actually set.

## Files

| File | Change |
|---|---|
| `web/src/lib/pwa.ts` | Immediate `update()` on build mismatch; export check/force as commented |
| `web/src/lib/server-build.ts` | Optional: expose “differs from `__BUILD_INFO__`” |
| `web/src/lib/pwa.ts` tests or `server-build.test.ts` | Mismatch triggers `update()`; match does not |
| Settings only if a button must call `checkForUpdate` | Wire existing ConnectionInfo |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- Observed id different from `__BUILD_INFO__.id` → `registration.update()` called once.
- Same id → no extra `update()` beyond the 60s interval.
- First-visit `controllerchange` still does not reload.
- Wedged path still unregisters before reload (unit-test the function; do not require a real SW).

## Done means

A live rebuild swaps the controlling worker in seconds instead of leaving the installed PWA on old freeze/ETag/poll code for up to a minute.
