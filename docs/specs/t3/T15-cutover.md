# T15 — Cutover: parity, `/` to v2, v1 at `/v1/`, retire herdr-acp

Status: draft (T3-shape series). Depends on: T09–T14 and T17–T19 done, and in daily use by Bart for at least a week. Read `README.md` in this folder first.

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
