# T18 — Settings, push and lock in web2

Status: done on feat/v2 (2026-10-17)

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

## Built

- **Layout (T3 names).** One page, `web2/src/routes/settings.tsx`, in the spec's order, not T3's child routes
  (`settings.general.tsx` …): a handful of rows read best as one scroll on the phone. Rows use T3's
  `SettingsSection` / `SettingsRow` (`components/settings/settingsLayout.tsx`, adapted: no search targets,
  scopes or inheritance; adds `disabled` and a small `SettingsChoice` radio group) on `SettingsGroup.tsx`
  (verbatim). `ThemeSettings.tsx` and `NotificationSettings.tsx` take T3's names (pattern). All five rows are in
  `web2/t3-upstream.json`; its `folders` now also list `components/settings/` and `routes/`. The v1 copies keep
  v1 names: `DisplaySettings`, `ComposerSettings`, `LockSettings`, `BridgeSettings`, `ConnectionInfo`,
  `PushOnboarding`, plus `hooks/use-theme.ts`, `use-display-prefs.ts`, `use-push.ts`, `use-notify-prefs.ts`,
  `lib/push.ts`, `lib/server-build.ts`. New API helpers sit in `lib/api.ts`.
- **Theme.** web2 is dark by default (T09), so the three-way is Dark / Light / System, not v1's System / Light /
  Dark. Same key (`sightr:theme:v1`); web2 stores `"dark"`, `"light"` or `"system"`. `.system` on `<html>` sets
  `color-scheme: light dark`, and index.css's `dark:` / `light:` variants follow the OS under it. v1 removes the
  key for its System, so a v1 System user sees web2's dark until they pick System in web2. theme-init.js adds
  `light` or `system` before paint.
- **Display.** Only the rows with a web2 meaning: Show thinking (v1's `sightr:display-prefs:v6` field, other v1
  fields kept as stored; off drops `reasoning` items in `MessagesTimeline`) and the Terminal tab's text size
  (T13's `rightPanelStore.terminalFontSize`, not v1's mirror font size). Tap to type, Show terminal and Raw
  terminal are v1 pane-screen prefs and are not shown. No desktop-mode control.
- **Composer.** The composer's gear menu is gone; Settings is the only place for Enter and Queue/Steer (still
  `state/composer.ts`). The Enter row shows the device default when nothing is stored.
- **Push.** `lib/push.ts` subscribes through web2's registration (`register(<base>sw.js, {scope: <base>})`, vite's
  base, so T15 needs no change) and only ever reads or unsubscribes a registration whose scope is web2's (v1's
  `/` scope also covers `/v2/`). `replaces` names v1's endpoint via the shared `sightr:push-endpoint`. Boot
  re-attach (`usePushSetup` in `__root`) differs from v1: it runs only when web2's own worker already holds a
  subscription the bridge no longer has as this device's, so opening v2 never moves push off v1 by itself.
  `PushOnboarding` sits at the top of the sidebar (v1 had it on the home list); it reads "seen" and read-only
  from the shell stream instead of v1's device store. Tests use a fake Push stack (`src/test/push.ts`).
- **Lock, bridge settings.** As v1, as rows. A bridge refusal now shows the bridge's reason ("Could not save
  bridge settings: bad notifyDelayMs."); `ApiError` gained `detail`. Removing a device that fails says so.
- **Connection.** `useBridgeInfo` now keeps the shell snapshot's `device`. Two build lines: this build
  (`__BUILD_INFO__`) and the web2 build the bridge serves (`x-sightr-build` from a `HEAD <base>sw.js`; the worker
  never precaches itself).
- **Shortcuts, wheel, v1.** Settings sits outside `ChatShell`, so it mounts `KeyboardShortcutsDialog` itself.
  `GestureWheelSettingsSlot` renders nothing until T19. "Open Sightr v1" links to `SIGHTR_V1_PATH` (`/`; T15
  changes it).
- **Leftovers taken in this run.** The composer's "Sent to the agent." verdict is cleared whenever the shown
  request changes (ChatComposer), with a test. The user-input panel's "Open terminal" already opened the
  Terminal tab after the T13 merge (`OpenTerminalButton` → `openRightPanelSurface`), covered by the existing
  ChatComposer test. MessagesTimeline "re-follows on this client's own send" now waits on the result.
- **Live check** (scratch bridge on 8796, own state and config dir, no VAPID keys, so no subscriptions were made
  and no WebAuthn credential was registered): in `ca`, Light applied to `<html>` and stayed across pages; Mod+Enter
  stored and the thread composer's `enterkeyhint` turned to `enter`; Notify delay 15 s saved to the scratch
  `settings.json` with "Set here · .env is 30 s"; both build lines matched; phone width reflows. Screenshots in
  the session scratchpad `t18-shots/`. `ca click <ref>` did not fire Base UI buttons (Save, Show shortcuts); a
  real CDP mouse click did. The on-phone push tap check is left for Bart.
