# T18 — Settings, push and lock in web2

Status: draft (T3-shape series). Depends on: T09 (`/settings` and `/pane/:paneId` routes, the v2 service worker's `push` handler, the lock prompt), T12 (Enter and Follow-up settings), T13 (shortcuts sheet). Read `README.md` in this folder first.

## Problem

web2 has a `/settings` route with nothing on it (T09). v1's Settings page (`web/src/routes/settings.tsx`) holds the
theme, display prefs, push notifications, the reconnect lock's device list, bridge settings, connection info and the
shortcuts link. Bart cannot switch to v2 (T15) until each of these works there. This slice ports them. It adds no
bridge route: every section calls an endpoint v1 already uses.

## Change

All in `web2/src/routes/settings.tsx` and `web2/src/components/settings/`. Copy the v1 components named below,
restyle them with the web2 tokens (T09), and import only leaf `@v1/lib/*` files, as T09's rules require.

### Sections, in order

- **Display.** Theme (copy `theme-control.tsx` and `hooks/use-theme.ts`). Display prefs from `display-prefs.tsx`
  (`DisplayPrefsContent`, `hooks/use-display-prefs.ts`), without the desktop-mode control: web2's layout is width-based
  (T09).
- **Composer.** T12's Enter setting and Follow-up setting, read and written where T12 stores them. This section only
  shows them.
- **Notifications.** Copy `hooks/use-push.ts`, `lib/push.ts`, `push-onboarding.tsx` and `notify-prefs-control.tsx`.
  - Subscribe through the v2 service worker registration (scope `/v2/` before cutover, `/` after T15). A device that
    subscribed in v1 has a different registration, so it gets a new endpoint here. Keep v1's `sightr:push-endpoint`
    key (same origin), so the subscribe body's `replaces` names the v1 endpoint and the bridge drops that row
    (`SubscriptionMeta.replaces`, collie#104). One device gets one notification per event.
  - The same bridge endpoints and per-device prefs as v1. Keep v1's iOS home-screen note (`IOS_INSTALL_NOTE`,
    `needsHomeScreenInstall`) and its failure text (`pushFailureText`).
  - A notification tap opens `/v2/pane/:paneId` (T09), which lands on the thread.
- **Security.** Copy `lock-settings.tsx`: list, register and remove WebAuthn devices with the `/api/lock/*` helpers T09
  already copied. Read-only devices see the list but not the controls.
- **Bridge.** Copy `bridge-settings.tsx`, same endpoint and read-only rule.
- **Connection.** Copy `connection-info.tsx` and the build line from `lib/server-build.ts`, showing the web2 build id.
- **Shortcuts.** A button that opens T13's shortcuts sheet (desktop only).
- **Gesture wheel.** An empty slot that T19 fills with the wheel picker.
- **Sightr v1.** A link "Open Sightr v1" to `/` (T15 changes it to `/v1/`).

## Invariants

- No new bridge endpoint; each section uses the v1 endpoint for the same setting.
- Read-only devices can read every section and change none of the bridge-side ones.
- Each per-device preference is wrapped in try/catch `localStorage` and the page renders without it.
- A push tap always lands on a thread or on the home screen with a notice, never on a blank page.

## Tests

- **Theme and display:** each control round-trips and survives a reload; no desktop-mode control.
- **Composer:** the section reflects T12's stored values and changing it changes the composer's behaviour.
- **Push** (msw + a fake `PushManager`): subscribe posts the endpoint with `replaces` set to a stored v1 endpoint; prefs round-trip; iOS non-installed shows the note;
  a failed subscribe shows the v1 failure text.
- **Lock:** list, register (fake WebAuthn) and remove; read-only hides controls.
- **Bridge settings and connection info:** load, save and the read-only rule; the build line shows the web2 id.
- **Live, on Bart's phone:** subscribe from web2, trigger a done notification, tap it, land on the thread.

## Notes for the planner

- The push and lock code in v1 imports `@/lib/...`. Use T09's `v1-scope` resolver or copy the files into
  `web2/src/lib/v1/`, as T09's notes allow.
- Before cutover the last UI to subscribe owns the device's push: subscribing in web2 replaces v1's row, and a later
  subscribe in v1 would replace web2's. That is the intended trade for never notifying twice.
