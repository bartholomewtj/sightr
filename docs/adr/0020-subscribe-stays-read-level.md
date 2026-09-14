# 0020 — Subscribe stays read-level

Status: **Superseded** by [0021](./0021-notification-settings-are-writes.md) (2026-08-17; marked 2026-08-19)

> `POST /api/subscribe` is **write**-level today (issue #8, ADR 0021). The endpoint validation and caps below still stand; only the access level changed.

## Context

GitHub issue #7 identified that `POST /api/subscribe` accepted arbitrary URLs and keys without validation,
which `Push.broadcast` would subsequently POST to upon agent events, creating a blind SSRF. Alongside endpoint
validation, the issue suggested "consider making subscribe write-level under the device gate".

In Collie, the per-device authorization gate (`COLLIE_DEVICE_HEADER`) allows operators to designate certain
devices as read-only. Read-only devices can view panes, inspect transcripts, and receive push notifications
when an agent needs input or finishes a task, but cannot type into terminals or perform destructive actions.

## Decision

**`POST /api/subscribe` remains a `read`-level route (`guard(req, cfg, "read")`).**

The SSRF vulnerability is closed by validating push endpoints against a strict push-service host allowlist,
capping stored subscriptions at 20, validating cryptographic key lengths, and passing a 10s send timeout to
`web-push`.

Raising `/api/subscribe` to write-level is explicitly declined:

- **Notifications for read-only devices are intentional.** A monitoring device (e.g. an operator's secondary
  phone or a dashboard display) is the exact use case for read-only access. Gating subscription behind
  write privileges would break notifications for precisely those devices.
- **Access elevation provides no additional security once endpoints are validated.** Because endpoints are
  strictly pinned to legitimate public Web Push services (and operator-configured push hosts), an attacker
  cannot use the route to target internal networks or arbitrary internet hosts.
- **Flood resilience is solved by capping stored subscriptions.** Capping subscriptions at 20 and rejecting
  excess registrations prevents fan-out amplification or disk growth without locking out read-only clients.

## Consequences

- Read-only devices continue to register for and receive Web Push notifications.
- The SSRF vulnerability (issue #7) is mitigated entirely at the validation layer in `bridge/push-endpoint.ts`.
- If a household needs more than 20 devices, the operator prunes stale subscriptions with `collie push forget`
  or configures a larger cap in code.
