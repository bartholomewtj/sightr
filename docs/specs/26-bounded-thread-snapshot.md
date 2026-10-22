# 26 — A thread opens on a bounded snapshot

Status: done — the bound landed in #136, the gzip frame and client resume in #138. Live-verified
22 Oct 2026 (numbers in Tests). Written 21 Oct 2026 from the responsiveness investigation. Part of
the Phase 1 plan in [`../ARCHITECTURE-ASSESSMENT.md`](../ARCHITECTURE-ASSESSMENT.md); this spec also
writes [ADR 0028](../adr/0028-a-thread-open-sends-a-bounded-snapshot.md).

## Problem

Opening a thread feels slow on the phone. It is not compute: the bridge's snapshot queries are
sub-millisecond on the live store, and the client's timeline derivations are ~7 ms for the biggest
real thread's 801 items. It is **payload**.

`bridge/threads/store.ts` `snapshotThread()` returns the newest **10** runs and **every item in them,
unbounded**, as one uncompressed SSE frame (`v2-routes.ts` `openStream`; `SSE_HEADERS` sets no
`Content-Encoding`). Measured against the live `threads.sqlite` (29 threads, 6,891 items):

| Thread | Snapshot |
|---|---|
| FL | ~1047 KB |
| Sightr ui 2 | ~1017 KB |
| Draftr | ~933 KB |
| … | 15 of 29 threads are >150 KB; 10 are >300 KB |

`web2/src/stream/thread-stream.ts` clears its store on every navigation and re-opens at cursor 0, so
**every click re-downloads the full snapshot**, and a reconnect after >128 events snapshots again.
Over Tailscale from a phone this is the whole delay.

## Change

- `bridge/threads/store.ts`
  - Add `SNAPSHOT_RUNS = 3` and `MAX_SNAPSHOT_ITEMS = 200` (exported).
  - `snapshotThread(id, o)`: default `o.runs` to `SNAPSHOT_RUNS`; after computing `from` from the
    returned runs, raise it to the position of the 200th-newest item (`ORDER BY position DESC LIMIT 1
    OFFSET MAX_SNAPSHOT_ITEMS - 1`) so the window holds at most ~200 items. Keep `historyCursor` =
    `encodeHistoryCursor(from)` whenever anything older remains, so the client pages it in as it does
    today.
- `bridge/threads/store.test.ts` — a thread with >`MAX_SNAPSHOT_ITEMS` items returns exactly the
  newest cap, a non-null `historyCursor`, and the newest run; a small thread is unchanged; runs are
  capped at `SNAPSHOT_RUNS`.
- `CHANGELOG.md` — one Unreleased line: opening a thread is much faster, and older turns page in as
  they did before.

### Follow-ups in this phase (separate increments, named here so they are not lost)

- **Gzip the snapshot frame** (`Bun.gzipSync` + base64 on the bridge; `DecompressionStream("gzip")`
  in `web2/src/stream/thread-stream.ts` before parse). ~4× on the wire, stacks with the bound.
- **Client resume** (`web2/src/stream/thread-stream.ts`): keep an LRU of recent thread state and
  re-open with `after=<sequence>` so returning to a thread replays deltas instead of re-snapshotting.

## Invariants

- The snapshot stays a **replacement**, never merged (T05); `historyCursor` keeps its paging contract.
- A bounded snapshot must not change which items are *newest*; only how far back it reaches.
- The shell stream (`shellRoute`) and the history route are unchanged.
- No new contract field, no harness-id branching; `shared/v2/contracts.ts` is untouched.
- The client needs no change for the bound to help (it already loads older history on scroll).

## Tests

- `store.test.ts`: the cap, the cursor, the runs cap, and the unchanged small-thread case.
- `v2-routes.test.ts`: the thread snapshot frame's items are ≤ the cap for a large fixture.
- Live (22 Oct 2026): the FL frame is 137,789 B, 200 items / 3 runs with `historyCursor` set, built
  in ~34 ms (was 1,607,891 B, 917 items / 4 runs); Sightr t3 158,389 B (was 2,143,796 B); Sightr ui 2
  53,641 B (was 1,052,289 B). Reopening FL with `?after=<sequence>` returns 129 B, not a snapshot.
