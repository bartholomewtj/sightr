# T15 — Cutover: parity, `/` to v2, v1 at `/v1/`, retire herdr-acp

Status: done on feat/v2 (2026-10-17). Was: draft (T3-shape series). Depends on: T09–T14 and T17–T19 done, and in daily use by Bart for at least a week. Read `README.md` in this folder first.

## Problem

v2 serves at `/v2/` beside v1. Until it does everything v1 does, Bart cannot switch. When he does, the installed PWA must update in place, v1 must stay reachable for one release, and the ACP bridge into T3 (`Projects\tools\herdr-acp`) is no longer needed.
Rule from Bart: v2 requires herdr >= 0.9.0 for everything; `/api/v2/*` answers 503 with a reason below that, and web2 shows it as a screen with a link to `/` (T09). At cutover `/` is v2, so that link points at `/v1/` from then on (see below). v1 keeps its routes for one release; the release after removes them.

## Part 1 — Parity checklist

Each row is a v1 feature, the place it lives in v2, and the check. This slice builds none of them: each row names the slice that does (T17 dialog parity, T18 Settings, push and lock, T19 parity ports). The slice does not start the cutover (Part 2) until every row is Done or has an accepted written exception from Bart in the PR.

| v1 feature (where in v1) | v2 home | Check |
|---|---|---|
| Needs-you inbox and triage buckets (`lib/triage.ts`, tree route) | T10 "Needs you" filter, roll-up dots, title count | A blocked, a done-unseen and a failed thread appear; count in tab title |
| Spaces tree, tabs, rename, close, new space/tab (`space-tree.tsx`, `new-space-sheet.tsx`) | T10 projects/threads, T14 new project and placement | Rename project and thread; close a pane archives the thread |
| Journal chat, folds, "Thought for Ns", older turns (`transcript-view.tsx`) | T11 | Same pane in v1 and v2 shows the same turns |
| Live terminal mirror, freeze, text size, raw dump (`ansi-output.tsx`) | T13 Terminal tab | Reads only while open |
| Tap-to-answer dialogs: prompt-select, menu, autocomplete, yes/no (`prompt-select-block.tsx`, `menu-block.tsx`) | T12 request panel | One live permission and one menu answered from v2 |
| **Multi-select, wizard (multi-step) and preview-select dialogs** (`multi-select-block.tsx`, `wizard-block.tsx`, `preview-select-block.tsx`) | T17: `question` requests with `multiSelect`, `steps`, `preview`, answered by the bridge's closed-loop recipes | One Claude multi-select, one wizard and one preview-select answered from v2; free-text rows stay in the Terminal tab |
| Guarded send, destructive-text confirm, force, no-echo notice (`composer-send.ts`, spec 24) | T06 on the bridge, T12 two-tap | Stranded draft case, `/model` picker case (blocked) |
| Keys pad with queue, modifiers, presets (`nav-tray.tsx`) | T12/T13 shared dock | `keys.toml` presets appear |
| **Gesture wheel** (`gesture-wheel.tsx`, `lib/wheel.ts`, `use-wheel-prefs.ts`, `wheel-prefs-control.tsx`) | T19: the phone composer beside Send, slices from `@v1/lib/wheel`; the Settings picker is T18 | Hold fans the wheel; six slices; Type slice arms direct typing |
| Direct typing, paste hold (`use-direct-typing.ts`) | T13 | Armed strip, disarm on blur |
| Find in pane (`find-bar.tsx`, `lib/find.ts`) | T19: `mod+f` (T13's `chat.find`) searches the timeline; the Terminal tab keeps find over the mirror (copy `find.ts` and `find-bar.tsx`) | Highlight and next/previous in both |
| Context usage, `/context` row (`lib/context-usage.ts`, `agent-chat.tsx`) | Slash catalog (T12) keeps `/context`; usage stays in the Terminal tab (T03 carries no usage) | `/context` from the slash menu shows usage in the Terminal tab |
| Statusline strip (`extractStatusLines`) | T19: the Terminal tab header shows the adapter's statusline run | Claude statusline visible |
| Files browse, preview, edit, delete, attach to reply (`routes/files.tsx`) | T13 Files tab, T12 attachments | Edit conflict (mtime) message still works |
| Git status and diff (`files-git.tsx`) | T13 Git tab | Same diff as v1 |
| Local servers (`routes/local.tsx`) | T13 Files tab section | Opens over the tailnet |
| Push, onboarding, per-device prefs (`use-push.ts`, `push-onboarding.tsx`, `notify-prefs-control.tsx`) | T18: subscribe, onboarding and per-device prefs in web2 Settings; the v2 SW `push` handler is T09; notification click opens `/thread/:id` | Push arrives on the phone and deep links |
| Reconnect lock, lock settings (`lock-prompt.tsx`, `lock-settings.tsx`) | T09 prompt; T18 register/remove in Settings | Add and remove a device |
| Settings: desktop mode, theme, display prefs, bridge settings, connection info, shortcuts (`routes/settings.tsx`) | T18: web2 Settings route. Desktop mode toggle is dropped (layout is width-based); adds Enter setting and Follow-up setting (T12) | Each setting round-trips |
| Connection telemetry and banner (`conn-telemetry.ts`) | T09 | `sightr-ctl conn` shows v2 sessions with `sse.open`/`sse.drop` |
| Read-only devices (`isReadOnly`) | T12, T13, T10 | Allowlist off: no writes anywhere |
| Whistlr decision cards (`docs/whistlr-31f-sightr.md`, `decisionReply`) | T04 publishes a marked card (`whistlr.decision thread=… run=…`) with `via: "whistlr"` and `decision`, and refuses `respond`; T19 routes it in `RequestPanel` to `POST /api/pane/:id/decision-reply`, which runs `whistlr reply`. Never keys. Unmarked requests stay on keys. | Marked and unmarked fixture each take their own path |
| PWA update on rebuild (spec 10), build stamp | Part 2 | Rebuild swaps worker in seconds |
| Pull-to-refresh, bottom nav, pane switcher sheet | Dropped on purpose (stream is live; sidebar replaces them) | Listed in the release note |

## Part 2 — The switch

- **Builds.** `web2` builds with `base: "/"` for production (the `/v2/` base stays for the dev preview via an env flag). `web` builds with `base: "/v1/"`, router `basename: "/v1"`, manifest `scope`/`start_url`/`id` `/v1/`, SW at `/v1/sw.js`. Both are minimal edits to `web/vite.config.ts`, `web/src/router.tsx`, `web/src/sw.ts` and the SW route denylist.
- **Bridge.** `bridge/static-assets.ts`: `/v1/*` serves `web/dist`, everything else serves `web2/dist`. The SPA fallback picks the tree by prefix. `/api/*` is unchanged, including v1's snapshot SSE and pane routes (they stay for the v1 release; the following release removes them, answering the open question in `README.md`). The `/v2/` prefix redirects (302) to the same path under `/`.
- **Build header.** `X-Sightr-Build` must tell each client about its own bundle. On `/api/*` the header carries the **web2** id by default; requests from v1 carry `x-sightr-ui: v1` (added to `web/src/lib/api.ts` in the same release) and get the v1 id. Without this, v1 at `/v1/` would see a build mismatch on every response and loop on `registration.update()` (spec 10). Test both.
- **Installed PWA migration** (spec 10's swap, in place). A phone has v1's service worker at scope `/`. After the switch, `/sw.js` is v2's worker. The old page sees the new build header, calls `registration.update()`, the browser fetches `/sw.js` (served `no-cache`), finds the v2 worker, installs, skips waiting and reloads on `controllerchange`.
  So v2's `sw.ts` must keep the same URL and scope and the `skipWaiting` + `clientsClaim` behaviour. It also clears v1's precache on `activate` (cache names differ) and denylists `/v1/`, `/api/` and `/auth` from the navigation fallback, so `/v1/` loads from the network and registers its own worker. The wedged-precache path (unregister then reload) from `pwa.ts` is copied into web2.
- **Deep links.** Old URLs must land somewhere: `/pane/:paneId` → look up the thread by `paneId` in the shell store and go to `/thread/:id` (else the home screen with a "Pane not found" notice); `/files/*`, `/local`, `/settings`, `/spaces`, `/space/:id` map to the matching v2 route. Push notifications queued by the old bridge format open via `/pane/…`, so the redirect is required, not optional. `last-path` restore from v1 localStorage is ignored.
- **Switching back.** A link "Open Sightr v1" in v2 Settings (T18) and on the herdr-too-old screen goes to `/v1/`. v1 shows a banner "Sightr v2 is the main app now" for the release it stays.
- **Rollback.** `SIGHTR_UI=v1` (bridge env) serves v1 at `/` and v2 at `/v2/` again without a rebuild. Document it in the release note.
- **Telemetry.** After the switch, run `/sightr-conn` once and compare to the pre-switch baseline: no worse reconnect rate.

## Part 3 — Release note and the release after

- `CHANGELOG.md` Unreleased: **Changed** — Sightr is now the thread-based app (list the dropped items from the table); **Added** — v1 stays at `/v1/` for this release; **Removed** next release — v1 files and routes (`web/` tree, `/api/events`, `/api/snapshot`, per-pane polling routes once nothing calls them).
- README feature screenshots are replaced later, not in this slice. Bump the version with `bun scripts/bump.ts minor --note "…"` (the repo script), not by hand.
- The follow-up release deletes `web/`, the `/v1/` serving, the `x-sightr-ui` header and the v1 snapshot routes. It is a separate slice.

## Part 4 — Retire `Projects\tools\herdr-acp` (Bart does this; the slice only describes it)

1. In T3 Code settings, remove the "Local ACP command" provider that runs `herdr-acp`.
2. Check nothing else starts it (Windows service entries, shell aliases, `herdr-acp` in any `commands.toml`).
3. Archive the folder: move `Projects\tools\herdr-acp` to the workspace archive location Bart uses, keeping `README.md` (the T3 contract notes may still be useful).
4. Remove its row from the workspace map (`C:\claudeOS\CONTEXT.md`) when Bart edits it.
The slice does not touch that folder or those files.

## Invariants

- No cutover step runs until the parity table is complete.
- An installed v1 PWA ends up on v2 without the user clearing site data.
- Neither UI sees the other's build id.
- `/v1/` works for the whole release and `SIGHTR_UI=v1` can restore the old front door.
- Whistlr marked cards never send keys.

## Tests

- **Bridge static** (`bridge/static-assets.test.ts`): `/` and `/thread/x` → web2 index; `/v1/` and `/v1/pane/p1` → v1 index; `/v1/assets/…` immutable; `/v2/foo` 302 to `/foo`; `/v1/sw.js` has `Service-Worker-Allowed: /v1/`; `SIGHTR_UI=v1` swaps the roots.
- **Build header:** a request with `x-sightr-ui: v1` gets the v1 id; others the web2 id.
- **Redirects** (web2): `/pane/:id` finds the thread; unknown pane notice; `/files/a/b` and `/settings` map.
- **SW** (unit, no real SW): the denylist covers `/v1/`, `/api/`, `/auth`; activate clears old caches; mismatch calls `update()` once.
- **v1 at `/v1/`:** its router tests run with `basename`; the `/v2/` denylist entry from T09 is removed; the "v2 is the main app" banner shows.
- **Parity:** the ported rows are tested in T17–T19. This slice records a live check of every row in the PR before Part 2.
- **Live, on Bart's phone:** installed v1 PWA opens after the switch and lands on v2 within seconds; a push from before the switch deep-links to a thread.

## Notes for the planner

- The former gap rows moved out: dialogs to T17, Settings, push and lock to T18, the wheel, find, statusline and whistlr cards to T19. The queue-resume command is T06's `queue.resume`.
- `docs/adr/0010` is about paste placeholders; the build-swap story is spec `10-pwa-build-swap.md`. This slice follows the latter.

## Built

Built on feat/v2 before the week of daily use the header asks for: the switch ships with the branch, and Bart decides when to merge it. The parity walk below is against the code.

**Parity walk.** Every row has its v2 home in the code (T10–T14, T17–T19) except one gap:
- **Missing: renaming a project in v2.** The bridge takes `project.rename` (T05), but web2 has no control for it; only threads can be renamed (row menu, palette). Small follow-up: a Rename item on the project row.
- Not re-run live here (read-only rule against Bart's panes): answering a permission, menu, multi-select, wizard and preview dialog, sending, the `/model` guard case, push arriving on the phone, adding and removing a lock device. Each was tested in its own slice. Checked live in this slice: the sidebar with the live herd, needs-you count in the title, a thread's timeline and Terminal tab, a `/pane/:id` deep link to its thread, v1 at `/v1/` with a pane open.
- Terminal "freeze" and "raw dump" have no separate controls: the Terminal tab is v1's raw mirror (T13), with text size.

**Deviations.**
- `SIGHTR_UI=v1` cannot put v1 back at `/` and v2 at `/v2/` without a rebuild, because each build bakes in its base. What it does instead: navigations outside `/v1/` redirect (302) into `/v1/` (old v1 paths like `/pane/x` keep their path, anything else lands on v1's home); `/sw.js` answers a small retiring worker (`RETIRE_WORKER_JS` in `bridge/static-assets.ts`) that replaces web2's worker on its next minute check, deletes that scope's precache, unregisters and reloads, so an installed phone falls back to v1 at `/v1/`. web2's other static files stay readable so a cached page keeps working until then. Checked live.
- Build header: v1 sends `x-sightr-ui: v1` on every fetch (`UI_HEADERS` in `web/src/lib/api.ts`, also push subscribe). `/api/events` is v1-only and an EventSource cannot set headers, so its `build` event always carries v1's id (`v1BuildId()`). The v2 streams carry web2's (`buildId()` now defaults to web2). `buildIdFor(req)` serves `/api/snapshot`, `/api/config` and the pane read routes.
- web2's worker does not clear v1's precache by name: at scope `/` both workers use the same cache name, so workbox's own activate drops v1's entries. `cleanupOutdatedCaches()` is deliberately not called: it deletes every precache whose name contains the scope URL, which includes v1's `…/v1/` precache (found live). It does drop the old v1's `/fonts/…` entries from `sightr-fonts`; v1 at `/v1/` sweeps its own.
- web2's worker also sends `/v2/…` navigations to the network (only when its base is `/`), so the bridge's redirect runs instead of the precached shell answering a path its router does not have.
- The update path in web2 reuses v1's `createUpdater` through `@v1/lib/pwa-update` rather than a copy; the shell stream's `build` frame feeds it. Both apps unregister only their own scope on a wedged precache, and count only their own worker as a prior controller (a first visit to `/v1/` is claimed away from web2's worker without a reload).
- Deep links: v2 has no Files route, so `/files`, `/files/*` and `/local` open the right panel's Files tab and go home; `/spaces` and `/space/:id` go home. `last-path` from v1 is ignored by v2, and v1's own last-path now stores app paths (the router's location carries the `/v1` basename; a doubled `/v1/v1/` was found live and fixed).
- v1 at `/v1/` re-attaches push only to a subscription its own worker holds, so opening v1 does not move the device's notifications off v2. An installed phone keeps its subscription through the migration because web2's worker takes over the same registration.
- web2's base comes from `SIGHTR_WEB2_BASE` (default `/`), for a `vite dev` preview only; web2's Vitest suite runs at `/v2/` (`test.env.BASE_URL`), which also proves nothing is pinned to `/`. v1's tests run at `/`.
- The version is not bumped here: `bun scripts/bump.ts minor --note "…"` is the release step at merge. `bump.ts` and `check-version.ts` now include `web2/package.json`.
- The root `build` script already built web2. `sightr-ctl build` (which herdr-plugin.toml's `[[build]]` and `update` run) now installs, typechecks and builds both apps into staging and swaps both only after both built; `start` builds on first run when either dist is missing.
- Not done: the `/sightr-conn` before/after comparison and the live check on Bart's phone; both need the real switch.

**Live check** (scratch bridge on 8793, own state dir, fresh Chrome profile; screenshots in the session scratchpad `t15-shots`): an old v1 build served at `/` installed its worker; after switching the bridge to this branch the open page moved to v2 at `/` within seconds, with v1's precache gone, no site data cleared, and no further reloads over the next half minute. `/v1/` loaded v1 from the network, registered its own worker at `/v1/`, showed the banner, opened a pane and survived reloads. `/v2/pane/<id>` redirected to `/pane/<id>` and on to the thread. A web2 rebuild was picked up by the open page; v1's precache survived it. Phone width at `/` shows the thread list.

**Release after.** A separate slice deletes `web/`, the `/v1/` serving, `x-sightr-ui`, `/api/events`, `/api/snapshot` and the per-pane polling routes once nothing calls them.
