# 25 — Tolerate a slow Herdr poll

Status: open. Not a council slice. Written 17 Oct 2026 from the bridge's connection log.

Another agent is working in the same checkout on v2 (`web2/`). This slice touches only `bridge/`,
`shared/conn.ts` and `scripts/ctl/conn.ts`. Work on a branch from `main`; do not touch `web/` or
`web2/`.

## Problem

The phone says "reconnecting", then "not connected", and every request is slow, whenever the PC is
busy. On 17 Oct (local time) the log shows it seven times in twenty minutes:

| Local | Herdr down for | What the PC was doing |
|---|---|---|
| 08:09 | 2.3 s | the web test suite finishing |
| 08:12 | 15.4 s | the root typecheck |
| 08:23 | 3.5 s | the v2 merge build and tests |
| 08:23 | 9.7 s | same |
| 08:25 | 23.6 s | same |
| 08:26 | 0.2 s | same |
| 08:26 | 0.4 s | same |

Every one of those lines reads `herdr session.snapshot: timed out after 5000ms`. Herdr was not gone;
it was slow. The `sightr-conn` report for that morning counts them as "Herdr link down 11×" over 0.7
visible hours, and the phone logged 22 gaps and 6 "lost" marks in the worst minute.

The mechanism, all in `bridge/state-engine.ts` `poll()`:

1. The engine asks Herdr for `session.snapshot` with the client's single per-request budget,
   `DEFAULT_TIMEOUT_MS` = 5000 (`bridge/herdr-client.ts`).
2. One rejection, of any kind, lands in the `catch`: `this.bridge = "disconnected"` and every link
   listener fires `("disconnected", message)`.
3. `bridge/index.ts` writes `herdr.down` to `conn.log`, and the next snapshot push carries
   `bridge: "disconnected"` to every phone, which shows the connection surface.
4. The next poll succeeds (Herdr answered late, or the load passed), the engine flips back, and the
   phone shows the green recovery flash. Under sustained load this repeats every few polls.

A timeout is treated the same as `EPIPE` or a refused socket. The first means "Herdr is busy"; the
others mean "Herdr is gone". Only the second deserves the disconnected state.

The Local tab's old loader (spec 23, fixed in #83) was one source of that load: a PowerShell spawn
every 1.5–4 s. It is gone, and the drops above happened on the fixed build. Test suites and builds on
the same PC are the remaining source, and they are not going away.

## Change

**`bridge/state-engine.ts`.** A transient failure does not flip the link on its own.

- Classify the error in one exported function, `isTransientPollError(err)`: true only for the
  client's timeout rejection (`timed out after`). Everything else (`EPIPE`, `ECONNREFUSED`, `ENOENT`,
  a bad reply, an error reply) is fatal and flips at once, exactly as today.
- Keep a count of consecutive transient failures. The link flips to `disconnected` on the second
  consecutive transient failure. A good poll resets the count. A fatal error resets it too (the link
  is down; the count no longer matters).
- After a transient failure that did not flip, the next poll runs after `pollMs` (1.5 s by default),
  not the current cadence. At the idle cadence (12 s) the second attempt would otherwise sit a full
  interval away, and a phone could look at a herd up to 22 s old before hearing anything. With the
  short retry, worst case to a flip is 5 + 1.5 + 5 s.
- While a transient failure is pending and the link is still `connected`, keep the previous herd,
  fire no transition and no update listener (nothing changed), and push nothing to phones.
- Log one `console.warn("[state] poll slow: …")` per episode, not per attempt.
- Do not change `DEFAULT_TIMEOUT_MS`. The leash is right; the policy on one miss was wrong.

**`bridge/index.ts`, `shared/conn.ts`, `scripts/ctl/conn.ts`.** Make the slow case visible without
counting it as an outage.

- A new bridge line `{ kind: "herdr.slow"; ms: number }`, written once per episode when the first
  transient failure is absorbed (`ms` is the budget it exceeded). `shared/conn.ts` is an allowlist;
  add the kind there and in the type union.
- `sightr-ctl conn` counts them in the Bridge line (`Herdr slow 7×`) and adds a `[low]` finding when
  there are any: "Herdr answered late N× (absorbed); if the PC was running tests or a build, that is
  the cause." `herdr.down` keeps meaning a real flip, so "Herdr link down" becomes the count of real
  outages.

## Tests

Colocated, in the style of the neighbouring files.

- `bridge/state-engine.test.ts`:
  - one timeout keeps `bridge: "connected"`, keeps the previous agents, calls no link listener and
    no update listener;
  - a second consecutive timeout flips to `disconnected` and calls the link listener once;
  - a good poll between two timeouts resets the count (the second one does not flip);
  - `EPIPE` on the first failure flips at once;
  - after an absorbed timeout the next poll is scheduled at `pollMs`, not the idle cadence (the
    existing cadence tests show how timers are faked);
  - `isTransientPollError` on the client's timeout message, on `EPIPE`, on an error reply.
- `bridge/conn.test.ts` or `scripts/ctl/conn.test.ts`: `herdr.slow` is accepted by the allowlist, is
  counted, and does not add to "Herdr link down".

## Out of scope

- The phone's thresholds (`TROUBLE_MS`, `CONNECTION_LOST_MS` in `web/src/lib/connection-health.ts`)
  and anything under `web/` or `web2/`.
- The 5 s per-request budget, the poll cadences, and any new env var or config key.
- Lowering the priority of test or build jobs on the PC. That is a workstation habit, not Sightr.
- Spec 23 and the Local tab. #83 already made it scan on a tap only.

## Done when

Root `bun run test` is green. `CHANGELOG.md` Unreleased gets one line under Fixed: the bridge no longer
reports Herdr as disconnected on one slow poll; two in a row, or a socket error, still do. The README
spec table gains row 25.
