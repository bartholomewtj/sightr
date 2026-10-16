# T09 — web2 shell: scaffold, adaptive layout, stream client

Status: draft (T3-shape series). Depends on: T05 (`/api/v2/*`), T01 (`shared/v2/contracts.ts`). Read `README.md` in this folder first.

## Problem

Sightr v2 needs a front end that talks to the event-sourced `/api/v2` API, not to the v1 snapshot poll. It must
ship beside v1 so Sightr stays usable every day until cutover (T15). Nothing exists yet: no `web2/`, no
`/v2/` route on the bridge, no client for the shell and thread SSE streams.

## Change

### Scaffold `web2/`

- **`web2/package.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `index.html`** (new). Copy the shape of
  `web/`: Vite, React 19, react-router 7, Tailwind 4, `class-variance-authority`, `clsx`, `tailwind-merge`,
  `lucide-react`, `vite-plugin-pwa` (`injectManifest`), Vitest + jsdom + Testing Library + msw. Add `zustand`. No
  Effect, TanStack or Tiptap. `base: "/v2/"`. Same `__BUILD_INFO__` stamp and `build-info.json` plugin as `web/vite.config.ts`.
- **Aliases.** `@` is `web2/src`, `@shared` is `../shared` (so `shared/v2/contracts.ts` is `@shared/v2/contracts`),
  and `@v1` is `../web/src`. `@v1` is for leaf files only: `@v1/lib/harness/*`, `@v1/lib/blocks`, `@v1/lib/ansi`,
  `@v1/lib/markdown`, `@v1/lib/key-queue`, `@v1/lib/transcript-fold`. Those files import each other by relative path (the
  harness files use no `@/`), so they resolve under any root. Do not import `@v1/components/*` or anything that
  pulls `@/`; copy the component instead.
- **`@/` inside v1 files.** Some v1 lib files T12, T13 and T19 want (`agent-commands.ts`, `operator-scope.ts`, `operator-keys.ts`, `wheel.ts`) import
  `@/lib/...`. Under web2 `@` would point at the wrong tree. Add a small Vite/Vitest resolver plugin (`web2/v1-scope.ts`): when the importer lives
  under `../web/src`, resolve `@/x` to `../web/src/x`; otherwise use web2's own `@`. A test pins this (an `@/lib/operator-scope` import from `agent-commands.ts` resolves to the v1 file).
- Mirror the alias in `tsconfig.json` `paths` and in vitest. Add `web2/src/test/setup.ts` modelled on `web/src/test/setup.ts`
  (msw server, `localStorage.clear()`, reset the stream and telemetry modules).
- **Look.** `web2/src/index.css` carries the workspace tokens from `C:\claudeOS\style\tokens.md`, recipe `console`, dark
  default, light as a mode, as `light-dark()` variables like `web/src/index.css`. Type is Segoe UI for text and Consolas
  for numbers, logs and code. Radius 12 px. Signature "you": the one control or row that needs the operator (a pending
  runtime request, T12) gets accent-soft fill and accent border; nothing else does. No new palette, no webfont, no motion
  beyond the working pulse (T10). Name each token after the tokens.md names (`--paper`, `--ink`, `--muted`, `--accent`,
  `--warn`, `--ok`, `--navy`) and alias the shadcn names to them.

### Served at `/v2/`

- **`bridge/static-assets.ts`.** `serveStatic` takes the root from the path: `/v2/*` resolves under `web2/dist`
  (`WEB2_DIR`), everything else under `web/dist`. `resolveStaticPath` gets a `webDir` argument it already has; pass the
  right one, and strip the `/v2` prefix. The SPA fallback for an extension-less path returns that tree's `index.html`
  (503 "web2 not built" if missing). `sw.js` under `/v2/` gets `Service-Worker-Allowed: /v2/`. `buildId()` is per tree;
  `X-Sightr-Build` on a `/v2/` response is the web2 id. `build-info.json` stays private in both. The Host check and CSP are unchanged.
- **v1 service worker must leave `/v2/` alone.** v1's `NavigationRoute` answers every navigation with the cached v1
  `index.html`, so `/v2/` would open v1. Add `"^/v2(/|$|\\?)"` to `NAVIGATION_NETWORK_ONLY` in `web/src/lib/sw-routes.ts`
  (and its test). Without this the slice does not work on an installed PWA.
- **Manifest.** `id` and `start_url` `/v2/`, `scope` `/v2/`, name "Sightr v2", same icons. The v2 PWA is a separate install.
- **`SW`.** `web2/src/sw.ts`: precache plus a `NavigationRoute` to `/v2/index.html` with a denylist for `/api/` and `/auth`;
  `push` and `notificationclick` handlers copied from `web/src/sw.ts`. The bridge's push payload names a `paneId`, not a thread, so the
  deep link is `/v2/pane/:paneId`: a route that finds the thread by `paneId` in the shell store and replaces itself with `/v2/thread/:id`
  (home with a "Pane not found" notice when none matches). T15 reuses it for old v1 URLs.
- **Build.** Root `build` script gains `cd web2 && bun install && bun run typecheck && bun run build`; add `build:web2` and `web2:dev`.
  Dev proxies `/api` to the bridge like `web/`.
- **herdr floor.** Below herdr 0.9.0 every `/api/v2/*` answers 503 with `{ ok: false, code: "herdr-too-old", error, have, need }` (T05). The client
  treats that as a full-screen state, not a banner over an empty app: "Sightr v2 needs herdr 0.9.0 or newer. This host runs
  {have}." with the `error` text and a "Open Sightr v1" link to `/`. It retries once a minute and leaves the screen by itself
  when the bridge answers 200. `EventSource` never exposes a status or body, so on a stream `error` the client makes one
  `fetch` of the same URL. A JSON 503 body with a `code` drives this state (or `v2-disabled`); anything else is a normal
  reconnect with backoff.

### App shell and layout

- **Router.** `createBrowserRouter` with `basename: "/v2"`. Routes: `/` (home: sidebar list on phone, "Pick a thread" on desktop),
  `/thread/:threadId`, `/pane/:paneId` (redirect, above), `/new` (T14), `/archived`, `/settings` (an empty page until T18). `RootLayout` owns the stream client and the lock gate.
- **Adaptive layout** (`web2/src/components/shell/`). One hook, `useLayout()`, from `matchMedia("(min-width: 1024px)")`; no
  user override in this slice.
  - ≥ 1024 px: three regions, `Sidebar | Chat | RightPanel`, sidebar width draggable (200–480 px, stored in `localStorage`),
    right panel collapsible. Regions are empty slots here; T10, T11/T12 and T13 fill them.
  - < 1024 px: the sidebar is the home screen; a thread is a full screen with a back button; right-panel tabs open as sheets (T13).
  - Safe-area insets and `100dvh` as in `web/src/routes/root.tsx`. The connection banner sits in flow at the top.
- **Lock.** Copy `use-lock-gate`, `lib/lock.ts` and `lock-prompt.tsx` from `web/src` into `web2`, using the same `/api/lock/*` endpoints
  and `api.ts` helpers (`fetchLockStatus`, `webauthnChallenge`, `unlockWebauthn`, `b64uToBytes`). A 401 lock response on any v2 call opens the prompt.

### Stream client (`web2/src/stream/`)

- **`shell-stream.ts`.** Opens `GET /api/v2/shell` with `EventSource` (`?client=<SESSION_ID>`). `snapshot` replaces the
  `shell` store (projects, threads, runtime-request summaries) and records its `sequence`. Each later event is applied only if
  `sequence` is greater than the last applied; equal or lower is dropped (dedupe). A gap larger than one is accepted for the shell
  stream (the bridge sends a fresh `snapshot` instead of a gappy replay). On reconnect the browser sends `Last-Event-ID`.
- **`thread-stream.ts`.** At most one open thread stream, for the route's `threadId`. `GET /api/v2/thread/:id?after=<seq>`.
  Server sends `snapshot {sequence, thread, runs, items, requests, queue, historyCursor}` (T05; when replay would exceed 128 events) or replayed events, then `synchronized`.
  The client marks the thread `syncing` until `synchronized` arrives. Switching thread closes the old stream first and clears its store.
- **`apply.ts`** (pure). `applyShellEvent(state, event)` and `applyThreadEvent(state, event)`: reduce by event `type`, return the same
  object when nothing changed, ignore unknown types (forward-compatible), never throw on a bad payload (drop and note it in telemetry).
- **Reconnect.** On `error` or no frame for 45 s (any frame counts, including `ping`; reuse the watchdog idea of spec 77), close and reopen with
  backoff 1 s, 2 s, 4 s, 8 s, capped at 15 s, with ±20% jitter; reset to 1 s after a frame arrives. A page returning to the foreground
  reconnects at once. After a reconnect that answers with `snapshot`, state is replaced, not merged.
- **Stores** (Zustand): `useShell` (projects, threads, requests), `useThread(threadId)` (items by id, runs, cursor, `syncing`), `useStreamHealth`
  (`connecting | live | lost`, last frame time). Selectors only; components never read the raw events.
- **Telemetry.** Import `@v1/lib/conn-telemetry` as is: `noteConn({ kind: "sse.open", connectMs })` on the first frame, `noteConn({ kind: "sse.drop", upMs, opened })`
  on error, `timedFetch("write", …)` for commands, `timedFetch("read", …)` for history pages. `startConnTelemetry()` runs in `main.tsx`.
  No new `FetchClass` (that would change `shared/conn.ts` and `sightr-ctl conn`); that is a follow-up if the baseline needs it.
- **Commands** (`web2/src/stream/commands.ts`). `sendCommand(type, payload)` posts `{ commandId: crypto.randomUUID(), type, … }` to
  `/api/v2/command` and returns `{ sequence }`. It retries a network failure once with the same `commandId`. It does not wait for the event.
- **Connection UI.** `ConnectionBanner` in web2 reads `useStreamHealth`: nothing while live; amber "Reconnecting…" after 4 s; red "Not connected"
  with Retry after 15 s. Same thresholds as `web/src/lib/connection-health.ts`.

### CI and root wiring

- `.github/workflows/ci.yml` is off-limits to a slice (README rules). Do not edit it. State in the PR text that Bart must add
  install, typecheck, test and build steps for `web2` next to the `web` ones.
- Root `tsconfig.json` is unchanged. A root test (`bridge/static-assets.test.ts`) covers the `/v2/` serving.

## Invariants

- v1 at `/` behaves exactly as before. Its tests stay green.
- No `web2` file imports from `web/src/components` or `web/src/routes`.
- `shared/v2/contracts.ts` is the only source for event and item types; web2 declares none of its own.
- An event with a sequence not above the last applied one never changes state.
- Switching threads never leaves two thread streams open.

## Tests

- **Bridge** (`bridge/static-assets.test.ts`): `/v2/` and `/v2/thread/x` return web2 `index.html`; `/v2/assets/a.js` is immutable-cached; `/v2/../web/dist/x` is 403;
  `/v2/sw.js` has `Service-Worker-Allowed: /v2/`; `/v2/build-info.json` is 404; `/` still serves v1.
- **sw-routes** (v1): `/v2/`, `/v2/thread/1`, `/v2?x=1` are network-only; `/v2x` is not.
- **apply.ts:** in-order events; duplicate and stale sequence ignored; unknown type ignored; malformed payload dropped.
- **Streams** (fake `EventSource`): snapshot then events; `Last-Event-ID` sent after reconnect; backoff steps and jitter bounds (fake timers); 45 s silence reconnects;
  `synchronized` clears `syncing`; thread switch closes the old stream; foreground event reconnects at once.
- **Commands:** same `commandId` on retry; 503 `herdr-too-old` surfaces as the full-screen state with a link to `/`; recovery on the next 200.
- **Layout:** 1280 px renders three regions; 800 px renders one stacked screen; resizing across 1024 px keeps the open thread.
- **Lock:** locked status renders the prompt; unlock opens the shell.
- **Telemetry:** `sse.open` and `sse.drop` notes are recorded with the page's `SESSION_ID`.
- **Live:** with the bridge running and T05 in place, load `/v2/` on a desktop and a phone-width window, kill the bridge, see the banner, restart it, see recovery with no duplicate items.

## Notes for the planner

- Importing v1 lib files is only safe where their import closure is also under `web/src/lib` (checked 16 Oct 2026: the harness files use relative paths and four `@shared` imports; `agent-commands`, `operator-*`, `wheel` use `@/lib`, hence the resolver plugin).
  If the plugin proves fragile, copy those four files into `web2/src/lib/v1/` instead and note it in the PR.
- v1 already has a desktop shell (`desktop-shell.tsx`, `lib/desktop.ts`, a layout switch at 768 px with `hover: hover`). web2 deliberately uses a plain
  1024 px width rule and no user toggle. Do not port `useDesktop`.
- v1 `command-palette.tsx` is the slash-command sheet, not a `mod+k` palette. T13 builds the palette fresh.
- `web/src/index.css` already says "House recipe: console" but its status hex (`#f87171` and others) are not tokens.md values. web2 uses tokens.md hex.
