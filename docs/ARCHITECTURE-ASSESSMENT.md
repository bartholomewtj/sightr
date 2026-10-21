# Architecture assessment (21 Oct 2026)

An assessment of Sightr's architecture, how future development presses on it, and the agreed plan.
It records the choices made in the 21 Oct interview so a later session does not re-derive them.
Written against `main` `d203f48`. The live runtime map is still [README → Architecture](../README.md#architecture);
this file is the *forward* view.

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
| Snapshot payload (measured: 15/29 threads >150 KB, several >1 MB, uncompressed) | Items within the newest 10 runs are unbounded; re-fetched on every open | Perceived responsiveness |
| Checkpoint git surface (`checkpoint-git.ts`) | Temp index + alternates against the operator's real repo | Diff trust |
| Dual PWAs + two token systems | Two workers/manifests/API clients/CSS token sets | Any visual/header change |

## How future development presses on it

### Upstream

- **T3 velocity** (React Compiler, ChatView decomposition, Effect) compounds sync debt faster than
  `/t3-sync` drains it; adapted rows become three-way merges. **First:** re-baseline the ledger, and
  settle the compiler decision.
- **Herdr protocol/version.** One file changes, but the version gate can go blind and the advertised
  floor (0.7.0) is below v2's real floor (0.9.0). **First:** reconcile the floors; gate off a signal
  that is not the RPC it gates.
- **New harness CLIs** are additive (descriptor + journal adapter + parser + fixtures). **First:**
  formalise the adapter contract and conformance tests.
- **Browser/iOS PWA** changes hit bespoke SW/keyboard code, not the core.

### Sightr's own roadmap

- **Retire v1** is a refactor, not a delete: the bridge imports 8+ v1 modules and web2 imports ~35 via
  `@v1`. **First:** extract `shared/harness/`.
- **Performance/large threads** needs bounded snapshots, compression and client resume.
- **Multi-device/read-only** semantics exist but are opt-in side-effects; Windows ACLs are weaker.
- **Scale** — the 50k-event floor is age-independent, item pruning is narrow, ingest maps are never
  reclaimed on thread delete.
- **Correctness depth** — status/mode/compaction depend on per-harness regexes.

## Triggers that would force re-architecture

Multi-user/multi-tenant; non-Windows hosting; a second bridge/multi-host federation; Herdr exposing a
real event API; dropping Tailscale; T3 diverging from the mirrored shapes; a native/Electron app. None
is on the table; the plan is reversible against all of them.

## Agreed plan

Choices from the 21 Oct interview, in order.

### Phase 1 — Responsiveness & scale (first)

- Bound `snapshotThread`: **3 runs + a ~200-item cap**, older pages in (spec 26).
- Gzip the snapshot frame (spec 26 follow-up).
- Client resume: keep recent thread state, re-open with a delta cursor (spec 26 follow-up).
- Exit: worst-case open well under ~150 KB; a regression is caught by a perf budget.

### Phase 2 — One front end

- Extract `shared/harness/` from `web/` (React-free), re-point the bridge (ADR-worthy; keystone).
- Move remaining `@v1` leaves into `shared/`/`web2/`; unify `api.ts` and tokens.
- Delete `web/`; `/v1/` redirects for one release; SW migration.

### Phase 3 — T3 adoption at a sustainable cadence

- Move the ledger `baseline` on **every** sync, and run **one bulk re-sync** of stale adapted rows.
- **React Compiler:** re-measure; **adopt at ≤ +12% bundle and no worse than −5% renders**, timeline
  row identity and scroll holding. Otherwise formalise the skip with a date.
- Add a sync-debt metric to the weekly issue.

### Phase 4 — Herdr & harness resilience

- **Advertise Herdr 0.9.0** in `herdr-plugin.toml` and gate v2 on it.
- Gate v2 off a version signal that is not `session.snapshot`; tolerate unknown event types.
- Harness adapter contract + conformance suite; fill Codex/Cursor/Agy journal gaps.

### Phase 5 — Correctness & safety

- Backstop status/mode/compaction scraping with structured signals where available.
- Harden checkpoint git isolation.
- **Queue after restart: auto-resume once the pane is idle, with a banner** (undoable).

### Phase 6 — Quality, observability, platform

- Raise web2 coverage toward parity; browser-level tests for the LegendList/scroll seam.
- **Windows verification: a documented manual smoke checklist before each release** (CI is
  ubuntu-only and the PowerShell launcher test never runs there).
- Dependency/lockfile audit; document the `@legendapp/list` pin.

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
