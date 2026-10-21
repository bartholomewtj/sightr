# 0028 — A thread open sends a bounded snapshot, not the whole recent thread

Status: accepted (21 Oct 2026). Written by [spec 26](../specs/26-bounded-thread-snapshot.md).

## Context

The v2 thread stream answers an open (or a reconnect past the replay bound) with a `snapshot` frame
that **replaces** the client's state (T05, `docs/specs/t3/README.md` "Transport"). `snapshotThread`
took the newest ten runs and returned *every item in them, unbounded*, as one uncompressed SSE frame,
and the client cleared its state and re-fetched on every navigation.

Measured against the operator's live store: 15 of 29 threads produced a snapshot over 150 KB, ten over
300 KB, the largest over 1 MB. Since the frame is uncompressed and re-fetched on every click, opening
a busy thread on a phone over Tailscale could fetch more than a megabyte of JSON before the timeline
could paint. The client's own compute was never the cost (timeline derivations: ~7 ms on the largest
thread); the payload was.

The roads considered:

1. **Send the whole recent thread and cache/compress on the client.** Simplest on the bridge; leaves
   the first open uncached and every new/reopened thread full-size.
2. **Send only the newest run and page everything else.** Smallest payload, but a thread's recent
   context is usually a few runs; scrolling back constantly would feel worse than one slightly larger
   open.
3. **Bound the window and let the existing history paging carry the rest.** Uses a mechanism the
   client already has (`historyCursor`, `loadOlderHistory`), keeps a few runs of context, and puts a
   ceiling on the frame that does not depend on how long a run grew.

## Decision

A thread open or reconnect sends a **bounded** snapshot: the newest **3 runs** and at most **~200
items**, with `historyCursor` set whenever older items remain so the client pages them in as it
already does. A snapshot stays a replacement, never merged.

The follow-up increments in the same phase add **gzip to the snapshot frame** and **client-side
resume** (re-open with a delta cursor), but the bound is the load-bearing part: it is what puts a
ceiling on the frame regardless of run size.

## Consequences

- Opening a thread fetches a fraction of what it did — the largest opens drop from ~1 MB to under
  ~150 KB — with no client change, because the client already pages older history on scroll.
- A single very long run can be cut by the item cap; its run banner may show with only its newest
  items until the operator scrolls. This is accepted: the alternative is an unbounded frame.
- The cap is fixed, not client-negotiated. If a screen or a connection needs a different window, add
  `?runs=`/`?items=` then — not before there is a measured reason.
- Revisit if per-open latency is still dominated by the frame after gzip and client resume land, or if
  operators report that three runs is too little context to open a thread usefully.
