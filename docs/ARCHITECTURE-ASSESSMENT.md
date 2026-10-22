# Architecture assessment (21 Oct 2026, updated 22 Oct 2026)

An assessment of Sightr's architecture, how future development presses on it, and the agreed plan.
It records the choices made in the 21 Oct interview so a later session does not re-derive them. The
22 Oct update turns the plan into per-phase execution detail: each slice carries its issue, the
files/seams it touches, the invariants that must hold, how it is tested, and its exit criteria.
Written against `main` `d203f48`; updated against `cf7fd2f`. The live runtime map is still
[README → Architecture](../README.md#architecture); this file is the *forward* view.

## What the system is

A single-operator, single-process, Windows-only bridge between a phone/desktop PWA and a
Herdr-controlled herd. One Bun process (`bridge/`, ~52k lines) owns all state and side-effects. Two
front ends speak to it: `web/` (v1, snapshot-polling, ~71k lines) and `web2/` (v2, event-sourced,
~72k lines). `shared/` (~2.5k lines) carries the contracts. Herdr owns the agents and the terminal;
Tailscale + WebAuthn are the trust boundary. The defining trait is that some correctness paths rest on
**screen scraping** (`web/src/lib/harness/*`), which the bridge imports at runtime.

## Scorecard

| Layer | Verdict |
|---|---|
| Bridge v1 (poll/send/guard) | Mature, dense tests, but coupled to `web/` (`bridge/guarded-send-route.ts`, `state-engine.ts`) |
| Bridge v2 (store/ingest/dispatch) | Strong core: single projection writer, receipts, migrations, retention (`bridge/threads/store.ts`) |
| Journal/harness adapters | Clean registry; per-harness cost is linear and manual (`bridge/journal/registry.ts`) |
| Contracts (`shared/`) | Small and capability-driven; no harness-id branching, enforced (`scripts/web2-harness-ids.ts`) |
| web2 | Fast-moving, thinnest coverage (~0.49 test:src); one all-or-nothing selector (`web2/src/stream/stores.ts`) |
| T3 adoption loop | Novel and disciplined, but structurally behind (`web2/t3-upstream.json`, `scripts/t3-upstream.ts`) |
| Herdr coupling | One file, but three disagreeing version floors |
| Security | Fail-closed host/Origin/identity; the rest is opt-in warnings (`bridge/access.ts`) |

## Load-bearing seams

| Seam | Why fragile | Blocks |
|---|---|---|
| bridge → `web/` runtime import (`guarded-send`, `dialog-sniff`, `dialog-recipes`, `composer-kit`, `blocks`) | A UI tree is a server runtime dependency | v1 retirement; safe refactors |
| T3 ledger baseline (`16918b57`, ~1,100 commits behind `origin/main`; rows pinned past it) | New-file detection diffs from an arbitrary point; ~171 undecided changes | Every sync slice; compiler decision |
| Herdr protocol reality | Empirical facts (0.7.2/protocol 16); the v2 gate reads `session.snapshot` to derive its own version; `events.subscribe` is all-or-nothing | Any Herdr upgrade |
| `useThread` whole-state selector | ~26 subscriber files re-render on every thread event | Streaming/timeline headroom |
| Snapshot payload | **Fixed** (Phase 1): bounded to 3 runs / ~200 items, gzipped, resumed by cursor | — |
| Static-asset payload | **Fixed** (spec 27): gzipped on the wire, KaTeX lazy | — |
| Checkpoint git surface (`checkpoint-git.ts`) | Temp index + alternates against the operator's real repo | Diff trust |
| Dual PWAs + two token systems | Two workers/manifests/API clients/CSS token sets | Any visual/header change |

## How future development presses on it

### Upstream

- **T3 velocity** (React Compiler, ChatView decomposition, Effect) compounds sync debt faster than
  `/t3-sync` drains it; adapted rows become three-way merges. **First:** re-baseline the ledger, and
  settle the compiler decision.
- **Herdr protocol/version.** One file changes, but the version gate can go blind and the advertised
  floor was below v2's real floor (now reconciled to 0.9.0). **First:** gate off a signal that is not
  the RPC it gates.
- **New harness CLIs** are additive (descriptor + journal adapter + parser + fixtures). **First:**
  formalise the adapter contract and conformance tests.
- **Browser/iOS PWA** changes hit bespoke SW/keyboard code, not the core.

### Sightr's own roadmap

- **Retire v1** is a refactor, not a delete: the bridge imports 8+ v1 modules and web2 imports ~36 via
  `@v1`. **First:** finish `shared/harness/`.
- **Performance/large threads** — done (Phase 1).
- **Multi-device/read-only** semantics exist but are opt-in side-effects; Windows ACLs are weaker.
- **Scale** — the 50k-event floor is age-independent, item pruning is narrow, ingest maps are never
  reclaimed on thread delete.
- **Correctness depth** — status/mode/compaction depend on per-harness regexes.

## Triggers that would force re-architecture

Multi-user/multi-tenant; non-Windows hosting; a second bridge/multi-host federation; Herdr exposing a
real event API; dropping Tailscale; T3 diverging from the mirrored shapes; a native/Electron app. None
is on the table; the plan is reversible against all of them.

## The plan

Choices from the 21 Oct interview, in order. Each phase below carries its **status**, the **slice(s)**
with their **issue**, the **files/seams** touched, the **invariants** that must hold, how it is
**tested**, its **exit** criteria, and any **gate** — a product choice a session must ask about rather
than decide.

One slice = one run. A slice is done when its tests are green in CI, its exit criteria hold, and the
CHANGELOG has its Unreleased line.

### Phase index

| Phase | Status | Issue |
|---|---|---|
| 1 Responsiveness & scale | **Done** — live-verified 22 Oct; specs 26, 27 | — |
| 1 leftover — a bundle/perf budget | Done — #155 | — |
| 2.1 slice 1 — `shared/harness/` (39 modules) | Done — #141 | — |
| 2.1 slice 2 — the last four modules | Done — #145, spec 28 | — |
| 2.2 retire v1 | Open | #146 |
| 3 T3 cadence — baseline, bulk re-sync, sync-debt | Open | #147 |
| 3b React Compiler re-measure | Open | #148 |
| 4.1 Herdr floor advertised | Done — #137 | — |
| 4.2 unknown event types tolerated | Done — #140 | — |
| 4.3 adapter contract + conformance | Open | #149 |
| 4.4 Herdr version signal | Open | #150 |
| 5.1 scrape backstops | Open | #151 |
| 5.2 checkpoint git isolation | Open | #152 |
| 5.3 queue auto-resume | Done — #139 | — |
| 6.1 web2 coverage + browser tests | Open | #153 |
| 6.2 Windows smoke checklist | Done — #137 | — |
| 6.3 dependency audit | Open | #154 |

### Order and dependencies

1. **#155** (perf budget) — done: `scripts/web2-budget.ts`, run in CI after the web2 build.
2. **#145** (2.1 slice 2) — done: `grep -r "../web/" bridge/` is empty; unblocks #146.
3. **#147 / #148** (Phase 3) — independent of Phase 2. #148 is a spike that may end in a formalised skip.
4. **#146** (retire v1) — unblocked by #145; the largest single change (deletes ~431 files).
5. **#149, #150, #151, #152, #154** — independent; any order.
6. **#153** (coverage) — after #146, so it does not write tests for code being deleted.

Nothing else is blocked from outside the repo. Only #148 (a T3 measurement) and the two gates below
need anything beyond the checkout.

### Phase 1 — Responsiveness & scale — done

- Bound `snapshotThread`: **3 runs + a ~200-item cap**, older pages in (spec 26).
- Gzip the snapshot frame (spec 26 follow-up).
- Client resume: recent thread state, re-open at a delta cursor (spec 26 follow-up).
- Live-verified 22 Oct 2026: FL's frame is 137,789 B, 200 items / 3 runs, ~34 ms (was 1,607,891 B,
  917 items / 4 runs); `?after=<sequence>` returns 129 B. Follow-up spec 27 then gzipped the static
  assets and made KaTeX lazy: the thread-route closure is 1,463 KB raw / **467 KB gzipped** (was
  1,725 KB raw, uncompressed).

**Done — the exit criterion "a regression is caught by a perf budget" (#155).** `scripts/web2-budget.ts`
walks the thread route's eager import closure (the entry plus the `_chat.thread._threadId` chunk,
static imports only) and fails CI past a documented raw/gzip ceiling; it runs in the existing job
after the web2 build (`bun run budget:web2`). The snapshot frame stays bounded by
`bridge/v2-routes.test.ts`.

### Phase 2 — One front end

**2.1 slice 2 — the last four `web/` modules (#145, spec 28) — done.**

Slice 1 (#141) moved 39 React-free modules into `shared/harness/` and left one-line re-exports at the
old paths. Four remained, and the bridge imported all four at runtime (and each one's full closure,
19 modules in the end, plus `sw-routes.ts`, which a bridge contract test still read):

| Module | Bridge importers |
|---|---|
| `web/src/lib/guarded-send.ts` | `bridge/guarded-send-route.ts` |
| `web/src/lib/dialog-recipes.ts` | `bridge/threads/free-text.ts`, `threads/respond.ts` |
| `web/src/lib/harness/dialog-kit.ts` | `bridge/threads/free-text.ts`, `threads/request-ingest.ts`, `threads/respond.ts` |
| `web/src/lib/harness/dialog-sniff.ts` | `bridge/state-engine.ts`, `threads/compaction-watch.ts`, `threads/dispatch.ts` |

Move each into `shared/harness/` and leave `export * from "…/shared/harness/X.ts";` at the old path.
Re-point the bridge importers above; the web-side callers (`web/src/lib/reply-action.ts`,
`harness/guard.ts`, `multi-select-action.ts`, `preview-action.ts`) can keep the shim.

- **Invariants:** `shared/harness/` stays free of `react`, `@shared`, `@/` and `@v1` imports (the root
  typecheck runs before the web install in CI); the shims are exactly one line.
- **Tests:** the existing suites for each module move with it; the root and web2 suites stay green;
  a conformance test asserts no forbidden import appears under `shared/harness/`.
- **Exit:** `grep -r "../web/" bridge/` is empty; `shared/harness/` has the four modules and the old
  paths are one-line re-exports.

**2.2 retire v1 (#146).**

After 2.1 slice 2 the bridge imports nothing from `web/`.

- Move the remaining `@v1` leaves into `shared/`/`web2/`: 19 `@v1/lib` modules (`agent-commands`,
  `conn-telemetry`, `connection-health`, `desktop-keymap`, `destructive`, `direct-arm`, `find`,
  `format`, `key-queue`, `links`, `mirror-cells`, `operator-keys`, `push-decision`, `pwa-update`,
  `thinking-pulse`, `wheel`, `harness/registry`), `@v1/components/mirror-space` (2 files), and the two
  that are already shims (`ansi`, `blocks`).
- Unify `api.ts` and the two CSS token sets.
- Delete `web/` (431 files, ~5.1 MB); `/v1/` redirects for one release.
- Remove v1's plumbing: `/api/snapshot` (`bridge/snapshot-route.ts`), `/api/events`
  (`bridge/events-route.ts`), `SIGHTR_UI` (`bridge/config.ts`), the `x-sightr-ui` header, and
  `RETIRE_WORKER_JS` (`bridge/static-assets.ts`) — keeping the service-worker migration so an installed
  PWA moves in place.

- **Invariants:** no `@v1` alias in `web2/vite.config.ts` or `web2/vitest.config.ts`; the root suite has
  no `web/` import; an installed v1 PWA still reaches the app.
- **Tests:** the web2 suite; `bridge/static-assets.test.ts` for the redirect; a SW-migration test.
- **Exit:** `web/` is gone; `/v1/…` 302s to `/`; the bridge and web2 typecheck and test without the
  alias; the version gate still passes.
- **Gate:** how long `/v1/` redirects, and whether `RETIRE_WORKER_JS` is kept for one release or
  dropped with the app.

### Phase 3 — T3 adoption at a sustainable cadence

**3 — baseline, bulk re-sync, sync-debt metric (#147).**

- Move the ledger `baseline` on **every** sync (agreed), not only on a bulk run.
- Run **one bulk re-sync** of the stale `adapted` rows in a single slice.
- Add the checker's "N undecided changes" to the weekly `t3-sync` issue as the sync-debt metric.

Files: `web2/t3-upstream.json` (181 files, 75 decisions, baseline `16918b57`), `scripts/t3-upstream.ts`,
`docs/T3_ADAPTATION.md`, `config/skills/t3-sync`.

- **Invariants:** the checker's guard (baseline is an ancestor of the sha) keeps passing; every moved
  row records the commit it was checked at; nothing is marked decided without a reason.
- **Tests:** `scripts/t3-upstream.ts`'s own tests; a run that reports zero undecided changes against a
  fixture.
- **Exit:** baseline is at T3 `main`; `--json` reports 0 undecided; the weekly issue carries the metric.
- **Gate:** none — the cadence is agreed.

**3b — React Compiler re-measure (#148).**

T23 recorded a **skip** (2026-10-18): the compiler bailed out on 21 of ~350 component functions, 200
streamed updates went 3801 → 3601 renders (−5%), JS +10% raw / +12% gzip, one NewThreadView test fails
compiled. The agreed bar: **adopt at ≤ +12% bundle and no worse than −5% renders**, with timeline row
identity and scroll holding.

- **How:** `SIGHTR_COMPILER=1` re-measures (see `docs/specs/t3/README.md`); run the compiler lint over
  `web2/src/components/**`; measure a long-thread scroll and a streaming reply on the phone.
- **Exit:** adopt (and re-port the deferred rows) or formalise the skip with a date in
  `docs/specs/t3/README.md` and a ledger `decisions` row.
- **Gate:** the adopt/skip outcome is the measurement's, not a preference — but a change to the bar
  itself is the operator's call.

### Phase 4 — Herdr & harness resilience

**4.3 — adapter contract + conformance (#149).**

Formalise what a harness adapter is — descriptor + journal reader + screen parser + captured fixtures —
and add a conformance suite every adapter must pass, so a new CLI is additive and provable.

Files: `shared/agents.ts`, `docs/HARNESS_CONTRIBUTING.md`, `bridge/journal/registry.ts`,
`web/src/lib/harness/registry.ts`, `web/src/fixtures/panes/`.

- **Invariants:** no harness-id branching outside the descriptor table (enforced by
  `scripts/web2-harness-ids.ts`); Herdr method names stay in `bridge/herdr-client.ts`.
- **Tests:** the conformance suite runs every registered adapter against its fixtures.
- **Exit:** a new harness can be added by descriptor + reader + fixtures, and the suite proves it.
- **Gate:** how far to push the Codex/Cursor/Agy journal gaps (Agy may stay screen-only).

**4.4 — Herdr version signal (#150).**

The floor is advertised (`min_herdr_version = "0.9.0"`, `HERDR_FLOOR` pinned by `herdr-floor.test.ts`),
but the version is still read from `session.snapshot` (`bridge/herdr-client.ts:388`) — the RPC the gate
guards, so a server that changes that reply can blind the gate.

- **How:** find a lighter, independent signal (a protocol version on connect, the shape of a cheaper
  call, a `version` RPC) and gate off that; keep `session.snapshot` as the fast path.
- **Tests:** `herdr-floor.test.ts` plus a case where a server without `session.snapshot` still reports
  its version.
- **Exit:** the v2 gate's answer does not depend on the RPC it gates.

### Phase 5 — Correctness & safety

**5.1 — scrape backstops (#151).**

`bridge/threads/mode-watch.ts`, `compaction-watch.ts`, `live-modes.ts` and
`web/src/lib/harness/dialog-sniff.ts` decide status, permission mode and compaction from the **screen**.
Where a harness exposes something structured, prefer it and keep the screen read as the fallback:

- Claude: the hook beacon in `bridge/beacon/`.
- Codex/Pi/Grok/Cursor: their session-log readers in `bridge/journal/`.

- **Invariants:** the screen read stays as the fallback (some harnesses expose nothing); no new
  harness-id branching in `shared/` or `web2/`.
- **Tests:** each backstop with its structured signal present, and the screen-only fallback.
- **Exit:** a harness with a structured signal no longer needs the screen for the backed-off field.
- **Gate:** which harnesses are worth it, and how much of the screen read can be retired per harness.

**5.2 — checkpoint git isolation (#152).**

`bridge/threads/checkpoint-git.ts` runs a temp index plus alternates against the operator's **real
repo**.

- **How:** its own object store, no writes to the user's index or config, and a clean refusal when the
  repo is mid-operation (rebase, merge, gc).
- **Tests:** the isolation holds with a real repo fixture; the refusal paths (mid-rebase, locked index,
  missing object) each have a case.
- **Exit:** nothing Sightr does can mutate the operator's index, config or refs.

**5.3 — queue auto-resume (#139) — done.**

### Phase 6 — Quality, observability, platform

**6.1 — web2 coverage + browser tests (#153).**

web2 is ~0.49 test:src and `web2/vitest.config.ts` sets no coverage threshold, so nothing stops the
ratio sliding.

- **How:** a ratcheting threshold in `web2/vitest.config.ts`, and browser-level tests for the timeline
  scroll / row-identity seam that jsdom cannot see (LegendList, streaming, jump-to-latest).
- **Exit:** the threshold is enforced in CI and the scroll seam has a real-browser test.
- **Gate:** the target coverage number.

**6.2 — Windows smoke checklist (#137) — done.**

**6.3 — dependency audit (#154).**

Audit the dependency tree and the lockfile for drift, and document why `@legendapp/list` is pinned at
`3.3.5` in `web2/package.json` — what breaks above it and what would unblock an upgrade.

- **Exit:** the pin is documented next to the dependency, and the audit's findings are either fixed or
  filed.

## Open gates (ask before deciding)

| Gate | Slice | Why it is the operator's |
|---|---|---|
| How long `/v1/` redirects; keep or drop `RETIRE_WORKER_JS` | 2.2 (#146) | A user-visible deprecation window and an installed-PWA migration |
| Change the compiler bar, or accept the formalised skip | 3b (#148) | The bar is a product trade-off (bundle vs renders) |
| Which harnesses get a structured backstop, and how far | 5.1 (#151) | Per-harness effort against a live-verified surface |
| The web2 coverage target | 6.1 (#153) | Sets the cost of every future slice |

## Decision log (21 Oct interview)

| Topic | Choice |
|---|---|
| First workstream | Responsiveness & scale (Phase 1) |
| Perf scope | Bound snapshot + gzip + client resume |
| v1 | Extract `shared/harness/`, then retire v1 |
| React Compiler | Re-measure; adopt at ≤ +12% bundle, ≥ −5% renders |
| Sequence | Phase 1, then `shared/harness/` + v1 |
| Windows checks | Manual smoke checklist per release |
| Snapshot bound | 3 runs + ~200 items, history pages in |
| Herdr floor | Advertise 0.9.0 |
| T3 cadence | Baseline each sync + one bulk re-sync |
| Queue restart | Auto-resume once idle, with a banner |
| Deliverable | Assessment doc + ADR + spec, then implement |

## Decision log (22 Oct interview)

| Topic | Choice |
|---|---|
| Plan's home | The assessment carries the execution detail; specs stay the build slices |
| Detail | All of Phases 2–6 written out, so a session can start anywhere |
| Choices | Decide what is decidable; the four gates above are asked |
| Queue | One issue per slice, labelled `roadmap`, linked from the phase index |
