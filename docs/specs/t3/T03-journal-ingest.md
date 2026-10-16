# T03 — Journal ingest: transcripts to turn items and runs

Status: draft (T3-shape series). Depends on: T01, T02.

## Problem

A thread's timeline needs stable, ordered turn items and run boundaries. The data exists in each harness's
session log, and `bridge/journal/*` already parses four of them (Claude, Pi, Cursor, Grok) into
`TranscriptEntry`. But `TranscriptStore` only serves whole parsed windows on demand for the v1 history route;
it has no notion of "what is new since last time", and nothing persists across a restart.

## Change

- **`bridge/threads/journal-ingest.ts`** (new). `createJournalIngestor({ store, engine, herdr, journals, transcripts, watchers, now, newId })`
  returns `{ start(), stop(), catchUp(threadId) }`.
  - **When it runs.** A thread is *active* when its status is `working`, or a client watches it
    (`watchers.count(threadId) > 0`; T05 owns the counter and passes it in). An active thread is read every
    1 s. A thread that becomes active gets one catch-up pass first. An idle, unwatched thread is not read.
    On start, one catch-up runs for every non-archived thread that has saved offsets, so a restart resumes.
    Harnesses with no adapter (`adapterFor` is undefined) skip the reading and only do the `screen` item below.
  - **Session ref.** Resolve exactly as the history route does. Extract that block of `paneHistory`
    (`bridge/pane-read-routes.ts`: `inferFromCwd` with `paneId`, `hint`, `peerPaneIds`, `reportedSessionId`,
    falling back to `pane.agentSession`) into an exported `resolveSessionRef(engine, herdr, adapter, pane)`
    and call it from both. `paneHistoryHint` is private today; it moves with it.
- **Incremental read.** Add `TranscriptStore.readSince(adapter, ref, saved)` in `bridge/journal/store.ts`:
  - `adapter.source.resolve(ref)` (containment stays where it is) then `stat`. If the size and mtime equal the
    saved ones, return `unchanged` without reading.
  - If `size < saved.offset`, or the path differs from the saved one, treat it as a new file: read from byte
    0 (clamped to the last 32 MB like `loadTail`) and flag `reset`.
  - Otherwise read from `max(0, saved.offset - OVERLAP_BYTES)` (256 KB), advanced to the next newline, up to
    the end of the file, and run `adapter.parse(text)`. Return `{ entries, nextOffset: size, size, mtimeMs, reset }`.
  - All four adapters parse JSONL line by line, so a window that starts on a line boundary is safe. The
    overlap exists because Claude folds a `tool_result` onto the `tool_use` that precedes it in the same
    parse; re-reading the last 256 KB lets a result that lands in a later chunk find its call. Items are
    upserted by id, so the repeated entries change nothing.
  - Offsets go to `journal_offsets` in the same transaction as the events they produced.
- **Entry → items.** One item per part, `id = ${entry.uuid}:${partIndex}`. An entry with an empty uuid gets
  `h_` + a short hash of `role|ts|first 80 chars of its first part`, so the id is still stable across re-parses.
  Mapping, in `bridge/threads/turn-items.ts` (pure):
  - role `user`, part `text` → `user_message`; role `assistant`, part `text` → `assistant_message`.
  - part `thinking` → `reasoning`.
  - role `summary` or `note` → `system_notice`.
  - part `tool` → `tool_call { toolKind, title: part.name, input: part.summary, output: part.result?.text, status }`.
  - `truncated` on a part is kept as `truncated: true` on the item.
  - `status`: `failed` when `result.isError`; `completed` when a result exists or `unrecorded` is set;
    `running` when there is no result and the thread's run is open; otherwise `completed`.
  - **toolKind** from the lower-cased tool name, one table, unknown → `other`: `bash`/`shell`/`exec`/
    `run_command` → `command`; `edit`/`multiedit`/`write`/`notebookedit`/`apply_patch`/`str_replace` → `file_change`;
    `read`/`view`/`ls` → `read`; `grep`/`glob`/`find`/`search` → `search`; `webfetch`/`websearch`/`fetch` → `fetch`.
    The table is pinned by a test against the tool names in each adapter's fixtures.
  - A pending Grok `ask` on a part is not a turn item. It is T04's input for the question card.
- **Runs.** Boundaries come from the status the T02 ingestor publishes, not from the log:
  - Status enters `working` with no open run → `run.started` (`ordinal` = last + 1, `status: running`).
    `blocked` → `working` inside a run is a continuation, not a new run.
  - Status leaves `working` to `done`/`idle` with a run open → `run.ended` (`completed`), or `failed` when the
    run holds an `error` item. An interrupt (T06) ends it `interrupted`: T06 marks the run row when it
    sends the interrupt key, and the next `run.ended` for that run says `interrupted`. Archive ends it `interrupted`.
  - The first `user_message` item whose `ts` is within the run (from 5 s before `startedAt`) and not yet
    claimed becomes `run.userItemId`. Items with a `ts` inside a run get its `runId`.
  - First ever ingest of a thread with no runs: backfill the last 50 entries, one completed run per
    `user_message`, in order, then continue live. Older items are read lazily by the history route (T05).
- **Session divider.** When `AgentView.agentSession` (or the inferred ref) changes for a thread, append a
  `session` item `{ id: "session:" + newKey, from, to }`, reset the thread's offsets, and read the new log
  from its start. A relaunch, `/clear` or `/new` therefore lands as a divider in one timeline. Claude
  compaction copies a lineage into a new file (`conversationRoot` in `journal/claude.ts`); for a Claude ref
  change, compare roots and skip the divider when they match.
- **`screen` items (no journal).** For a thread whose harness has no adapter (Agy; Codex is not a registered
  agent id in `shared/agents.ts` yet), when a run ends, read the pane once and append one `screen` item
  `{ id: "screen:" + runId, text, capturedAt }`:
  `herdr.readPane(paneId, "visible", 60, "text")`. **`visible`, never `recent`.** `docs/HERDR_API.md` records
  that a `recent` read for more rows than the viewport makes herdr scroll the operator's pane up and back, and
  `state-engine.ts` documents the same rule for every background read. Strip trailing blank lines, cap at
  8 KB. User messages sent from Sightr (T06) are written by that slice as `user_message` items.
- **Failure.** A missing log, a refused ref or a throwing adapter produces no events and one logged warning
  per thread per 10 minutes. It never fails a poll or another thread.

## Invariants

- Re-reading the same bytes appends nothing: items are upserted by id and only a changed body emits
  `turn-item.updated`.
- Offsets are saved in the same transaction as the events from that read; a crash re-reads at most the overlap.
- An item's id never changes across re-parses, restarts or a window shift.
- No journal read happens for a thread that is idle and unwatched.
- Journal paths stay behind `adapter.source.resolve`; no path is taken from a request or from the store.
- No background read of the pane uses `source: "recent"`.

## Tests

Temp sqlite, fake adapter whose `source` serves in-memory strings and counts reads; Claude fixtures for the
real grammar.

- **turn-items (pure):** each role/part pair; tool status from result/unrecorded/error/pending; the toolKind
  table over every name seen in `bridge/journal` fixtures; empty-uuid fallback id stable across calls.
- **readSince:** unchanged stat reads nothing; append reads from `offset - overlap`; truncation or a new path
  flags `reset`; a result in a later chunk attaches to its call within the overlap; a partial last line waits.
- **Idempotence:** run `catchUp` twice on the same log → second appends no events.
- **Runs:** working → idle makes one run and attaches the first user message; blocked mid-run does not split
  it; an error item fails it; archive interrupts it; backfill builds one run per user message.
- **Session divider:** ref change appends one `session` item, resets the offset, and does not reorder old items.
- **Scheduling:** an idle unwatched thread causes zero `resolve` calls; a watcher starts a catch-up;
  a restart with saved offsets resumes without re-emitting.
- **Screen:** an Agy thread's run end reads with source `visible` (assert on the fake Herdr's recorded call),
  caps the text, and emits one item.

## Notes for the planner

- `TranscriptEntry` carries `name` and a one-line `summary` for tools, not the structured input, so
  `tool_call.input` is that summary string. A richer input needs adapter changes and is out of scope here.
- Cursor records no tool output, so its tool items complete with no `output`.
- If the slice is too large, cut the backfill (start with an empty timeline plus live items) and the `screen`
  item; both can follow without changing ids.
- Codex has no registered agent id yet (T16 adds the journal). Until then a Codex pane is a thread with
  harness equal to whatever herdr reports.
