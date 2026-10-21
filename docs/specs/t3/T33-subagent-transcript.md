# T33 — Subagent transcript: tap an agent in the panel and watch what it is doing

Status: built 21 Oct 2026 (interview with Bart: "full live transcript"). Depends on: T32 (one item per agent, grouped panel). Pi and Claude.

## Source (checked on this PC, 21 Oct)

Both harnesses already write each subagent's own conversation to disk.

- **Claude:** `~/.claude/projects/<mangled-cwd>/<session-uuid>/subagents/agent-<agentId>.jsonl` plus `agent-<agentId>.meta.json`. Rows are the normal Claude journal shape with `isSidechain: true` and `agentId`; `parseClaude` already reads them when `includeSidechains` is set (`bridge/journal/claude.ts:473`).
- **Pi:** `~/.pi/agent/sessions/<mangled-cwd>/<session>/tasks/<ts>_<uuid>.jsonl`, the ordinary Pi session format (`bridge/journal/pi.ts`). The file name carries no agent id; `get_subagent_result`'s `details.transcriptPath` names it. A still-running agent's `get_subagent_result` carries `transcriptPath` too (checked 21 Oct), so no matching by launch time is needed; an agent never checked has no path yet (its card says the transcript is not available until the first check).

## Change

- **Bridge:** `GET /api/threads/:id/subagents/:subagentId/transcript?cursor=` returning turn items in the thread's existing item shape, reusing the harness parsers and the journal path-confinement in `bridge/journal/files.ts` (the path comes from a log, so it is hostile input: confine it to the harness's own root). Tail-read, capped like the main journal; a cursor for "newer than". Events: a `subagent.activity` hint on the thread stream so a running agent's open view refreshes without polling the whole file (poll the file at 2 s only while a view is open).
- **Web2:** the agent row in T32's panel opens a sheet (below 1024 px; `history.pushState` so Back closes it, the T13 rule) or a side panel (above). The body is the existing `MessagesTimeline` item renderers fed with the subagent's items, read-only, follow-to-bottom while running. Header: name, status, elapsed, a Stop-following toggle.
- **Current state strip** on the agent row (works without opening it): the latest tool call or sentence from the same transcript, tool count and tokens live.
- Nothing branches on harness id; the bridge returns a capability flag `subagentTranscript` on the thread.

## Risks

Large transcripts (the Pi task files sampled are 0.6–1.1 MB): paging and a cap are required. A subagent that is still being written can have a half row at the tail; the parsers already tolerate it for the main journal, reuse that. Claude sidechain rows must not leak into the main thread (they stay dropped there).

## Done when

A running Pi subagent and a running Claude subagent each show new lines in the open view within ~3 s; a finished one opens with its whole transcript; a path outside the harness root is refused (test); suites and typechecks pass; checked in a 390 px page.

## Build amendments

- **Route:** `GET /api/v2/thread/:threadId/item/:itemId/transcript[?size=<n>|?latest=1]` (`bridge/threads/subagent-transcript.ts`). The client names an item; the bridge finds the agent's other items by `subagentId`, takes Claude's log path from the agent id (strict `[A-Za-z0-9_-]{1,64}`, under the session directory, or a sibling session's after `/clear`) and Pi's from the `transcriptPath` a check recorded on any of the agent's items. Both must be `.jsonl` files whose real path lies inside the thread's own log directory. Reads the newest 2 MiB (256 KiB for `?latest`), returns at most 300 items; ordinals keep their place in the log.
- **Item fields:** `subagent.transcript?: true` (the log can be opened) and `transcriptPath?` (Pi's, bridge-side input, never sent back). Claude's `transcript` is set from the agent id alone; Pi's only once a check has named the file, so a never-checked Pi agent has no Watch button.
- **Polling, not a stream event.** The spec's `subagent.activity` hint was not built: an open view re-reads every 2 s (`?size=` makes an unchanged log a tiny answer), and a running agent's closed row asks `?latest=1` every 6 s while on screen and visible.
- **Viewer:** its own read-only list in `SubagentTranscriptSheet.tsx`, not `MessagesTimeline` (which is tied to the thread store, find and history). A tool call is a one-line row that opens to the main timeline's `ToolItemDetail`. Bottom sheet on a phone with a history entry (Back closes), side sheet on desktop; follows the end while running, scrolling up leaves follow mode.
- Not built: steering, and Codex/Grok logs.
