# 07 — Beacon session must not clobber Herdr

Council row 7. Severity: high. Journal.

## Why

`decorateAgent` in `bridge/beacon/decorate.ts` always writes `agentSession: identity.session` when a beacon exists for the pane. It does not require `identity.agent === view.agent`. Status is live-only (`identityOf` only copies status when `liveness === "live"`), but **session is always copied**, including expired readings (`BEACON_TTL_MS` 12h in beacon liveness). `paneHistory` then reads that session. After `/clear`, `/resume`, or a harness swap, yesterday’s hook file is the chat.

Comments already say a beacon must not change `agent`, `kind`, or `paneId`. Session is the hole.

## Do

- Apply a beacon session only when the reading is **live** and `identity.agent === view.agent` (or the pane’s harness family matches).
- If Herdr already reports a different `agentSession` / session id, keep Herdr’s.
- Expired beacons may still open history **only when Herdr named none**.
- Keep `waiting → blocked` status mapping for live readings. Keep “do not promote a shell to an agent”.

## Do not

- Let a beacon send input (already true; do not add writes).
- Change journal adapters, Grok WEAK claims (row 08), or paging (row 09).
- Delete the 12h TTL; use it.

## Files

| File | Change |
|---|---|
| `bridge/beacon/decorate.ts` | Session apply rules |
| `bridge/beacon/beacon.test.ts` (or decorate tests) | Live/expired/mismatch/Herdr-wins |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- Live matching harness, Herdr unnamed: beacon session is used.
- Live matching harness, Herdr reports a different id: Herdr wins.
- Expired reading: session applied only if Herdr named none; status not applied (already).
- Harness mismatch: session not applied; agent/kind/paneId unchanged.
- Shell pane: still not promoted.

## Done means

Phone chat follows the session the live pane is on, not yesterday’s hook file.
