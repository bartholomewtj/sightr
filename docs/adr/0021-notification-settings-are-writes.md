# 0021 — Notification settings are writes

Status: **Accepted** (2026-08-17)

## Context

The device gate (`COLLIE_DEVICE_HEADER`) was originally scoped to terminal-driving actions (replies, keys, uploads, and pane/tab lifecycle). Read-only callers and requests arriving without the header were permitted to call `/api/subscribe`, `POST /api/notifications/snooze`, `POST /api/notifications/prefs`, and `POST /api/update/check`.

However, snooze and notification preferences are *bridge-wide* state ([ADR 0003](./0003-one-shared-seen.md)). A single non-allowlisted device, or any other user ID on the host that reaches the loopback port, could mute all notifications (`snoozedUntil: 9e15`) or turn off all push events (`{blocked: false, done: false, updates: false}`), silencing the operator's "agent is waiting" alerts across every device. Furthermore, a push subscription is a standing grant to receive the operator's alerts.

None of these actions drive a terminal directly, but silencing the herd represents damage to the operator's workflow—precisely the damage the device gate was designed to bound.

## Decision

1. **Snooze, notification preferences (POST), and push subscriptions are promoted to `"write"` level.** Any device not in `COLLIE_DEVICE_ALLOWLIST` (or omitting the device header) receives a `403 Forbidden` on these routes.
2. **`GET /api/notifications/prefs` and `POST /api/update/check` remain `"read"` level.** Reading which alert types are configured discloses nothing and mutates nothing. Checking for upstream releases is not operator-visible state; its risk (exhausting anonymous GitHub rate limits) is addressed by a 60-second attempt cooldown in `UpdateMonitor` rather than access gating.
3. **Require an `Origin` header on every state-changing request (`POST`, `PUT`, `DELETE`, etc.), regardless of access level.** A non-loopback POST without an `Origin` header is rejected across all routes.
4. **No third `"settings"` access level is introduced.** The access control behavior, client-side read-only predicate, and security boundaries are identical to the write level; a third level would add unnecessary branching.
5. **Snooze deadlines are capped at 7 days (`MAX_SNOOZE_MS`).** Excessively large deadlines (or persisted legacy values) are silently clamped on storage and on reload rather than rejected, preventing indefinite silencing.

## Consequences

- **Breaking only when `COLLIE_DEVICE_HEADER` is enabled:** A read-only device can no longer snooze alerts, alter notification preferences, or register for push notifications.
- **The settings UI explicitly communicates read-only restrictions:** Instead of silently failing or flipping switches that fail on the backend, the settings page disables the controls and displays an actionable explanation.
- **The bridge's loopback URL behaves as read-only when device auth is enforced.** Accessing Collie directly over loopback without the proxy's injected header cannot change notification settings without supplying an allowlisted device header.
- **These routes remain excluded from `audit.log`.** The audit log continues to specifically record actions typed into or executed in a terminal.
