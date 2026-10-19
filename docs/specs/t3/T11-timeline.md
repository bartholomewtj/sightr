# T11 — Timeline: turn items, work log, thinking, run banner

Status: done on feat/v2-web (2026-10-16). Depends on: T09 (thread store), T03 (turn items and runs), T05 (history paging). Read `README.md` in this folder first.

## Problem

v1 renders a thread as a journal transcript above a polled terminal dump (`web/src/components/transcript-view.tsx`, `agent-chat.tsx`). The user message, the thinking pulse
and the dump are stitched together in the browser (`lib/thinking-pulse.ts` pending-user logic). v2 gets stable turn items and run boundaries from the bridge, so the
timeline can be one plain list rendered from the thread store.

T3 reference (patterns only; MIT, comment the source if logic is adapted): T3: `apps/web/src/components/chat/MessagesTimeline.logic.ts`, `chat/WorkLog.tsx`.

## Change

All in `web2/src/components/timeline/` and `web2/src/state/timeline.ts`, filling the Chat slot's middle region from T09.

### Rows from items

`buildRows(items, runs)` is a pure function over the thread store's ordered items. Row kinds:

- **message**: `user_message` or `assistant_message`. Assistant text renders through the markdown renderer (below). A user message shows the text and attachment chips.
- **work-log**: a run of consecutive `tool_call` items with no message between them folds into one row (see below).
- **reasoning**: a `reasoning` item, collapsed to "Thought for 12s". Tap expands the text.
- **session**: a `session` divider ("New session · Claude 2.1.301 · 14:02"). Not collapsible.
- **notice**: `system_notice` and `error` items. Errors use warn tokens and say what happened and what to do; they never apologise.
- **screen**: a `screen` item (harnesses with no journal, README "Ingest"). A bordered Consolas block rendered with the existing ANSI renderer (`@v1/lib/ansi`, copy of
  `web/src/components/ansi-output.tsx`'s span rendering, no block grammars), capped at 40 lines with "Show all". Label: "Screen at end of run".
- **day**: a day divider when the calendar day changes (the idea behind `FoldItem` "divider" in `web/src/lib/transcript-fold.ts`).
- **banner**: the run banner, always last (below).

### Work log grouping

- Consecutive `tool_call` items between two non-tool rows become one group, header "Ran 3 commands" or "Ran 2 commands, edited 1 file, read 4 files". Counts come from `toolKind`:
  `command` → ran, `file_change` → edited, `read` → read, `search` → searched, `fetch` → fetched, `other` → used N tools. Order: the first-seen kind first. A single tool is a one-line row, not a group.
  Reuse the idea of `foldLabel` in `@v1/lib/transcript-fold`; the label builder is new because the input is `toolKind`, not tool names, and it must emit plain strings only (no markup).
- A group is collapsed when all its tools are `completed`. It is expanded while any tool is `running`, and shows the running tool's title on the header. The user's manual toggle wins and is kept in component state by group id (first item id).
- Expanded, each tool row shows an icon by kind, the title (command line, path, query) in Consolas, a status mark (spinner, check, cross) and a "Show output" toggle. Output is lazy: not mounted until opened, truncated at 200 lines with a note when the item has `truncated`.
  A tool with no recorded output (`output` absent and harness known to omit it, as Cursor) shows no toggle, not an empty box.
- A failed tool uses warn tokens and stays expanded.

### Reasoning duration

- "Thought for Ns" uses the `reasoning` item's own `startedAt` and `endedAt` when present; otherwise the gap to the next item in the same run, ignoring idle gaps above `MAX_THINK_SECONDS` (10 min, the constant in `@v1/lib/transcript-fold`). While the run is `running` and the reasoning is the last item, it reads "Thinking…" with elapsed time. Under 1 s it reads "Thought briefly".

### Run banner

- While the newest run is `running`: a row at the end of the list "Working · 1m 24s" (Consolas time, ticking each second, `elapsed()` from `@v1/lib/thinking-pulse`) with the working pulse from T10. Runs are never `queued`: T06 queues messages, not runs. If the thread has queued messages, the row adds "· 2 queued"; the list itself is T12's.
- A run that ended `interrupted` adds a notice "Stopped"; `failed` adds an error notice with the run's reason.
- When the thread status is `approval` or `input` the banner reads "Waiting for you" (T12 draws the request itself).

### Virtualization and scrolling

- Virtualize with `@legendapp/list`, as T3's `MessagesTimeline.tsx` does (README "Adapting T3 components"). Build the row model in `components/chat/MessagesTimeline.logic.ts` with T3's row kinds where they apply (`message`, `work`, `work-toggle`, `working`, `thinking`, `event`), adopting T3's pure logic file as far as our item shapes allow and recording it in `web2/t3-upstream.json`. Rows are keyed by item id (stable, T03), so an update replaces a row in place.
- **Follow mode.** Stick to the bottom while the user is within 80 px of it. A scroll up leaves follow mode and shows a "Jump to latest" pill with a count of new items. New items from this client's own send always follow. Reuse the approach (not the file) of `web/src/hooks/use-auto-scroll.ts`.
- **History paging upward.** The thread snapshot carries `historyCursor`. When the top spacer enters view, call `GET /api/v2/thread/:id/history?before=<cursor>`, prepend the page, and keep the visible row anchored (adjust `scrollTop` by the added height). One request in flight; a page with no cursor sets `exhausted` and shows "Start of thread". A failure shows a retry row, not a toast loop.
- On `snapshot` replacement (resume after a gap) keep the scroll anchor by the nearest row id if it still exists, else go to the bottom.

### Markdown and code

- Reuse `@v1/lib/markdown` (`parseMarkdown`, `MdBlock`, `MdSpan`) and copy `web/src/components/markdown-text.tsx` into web2 as `timeline/markdown.tsx`, restyled with the tokens. Links open with `rel="noopener noreferrer"`; keep the link rules of `web/src/lib/links.ts` (copy). No HTML injection: spans render as text nodes.
- Code blocks: Consolas, horizontal scroll, a Copy button (the clipboard call wrapped in try/catch with a status line on failure). No syntax highlighter in this slice.

### Empty and loading states

- Before `synchronized`: skeleton rows, not a spinner. A thread with no items: "No messages yet. Type below to start." A harness with no journal and no screen items: "This harness has no transcript. Open the Terminal tab." (the tab exists from T13).

## Invariants

- The timeline renders only from the thread store; it never reads the pane or v1 endpoints.
- Item ids are stable across snapshot, replay and history, so no row duplicates or flickers after a reconnect.
- A running tool group is never collapsed by the app.
- Text from items is never inserted as HTML.
- History paging never loses the reader's place.

## Tests

- **`buildRows`:** groups consecutive tools; a message between tools splits groups; a single tool is not a group; counts and label for mixed kinds; day dividers; session divider; banner present only for a live run.
- **Reasoning:** explicit start/end; gap fallback; idle gap above 10 min omitted; live "Thinking…"; sub-second wording.
- **Group state:** collapsed when done, expanded while running, user toggle persists across an update, failed stays open, no-output tool has no toggle, output truncation note.
- **Banner:** working time ticks (fake timers); queued wording; interrupted and failed notices; "Waiting for you" on `approval`.
- **Virtualization:** 5,000 items mount fewer than 80 row nodes; scrolling mounts the new window; a row height change does not jump the viewport.
- **Follow mode:** sticks while near the bottom; scroll up shows the pill with a count; own send re-follows.
- **History paging** (msw `/api/v2/thread/:id/history`): prepend keeps the anchor; one in flight; end-of-thread; failure shows retry.
- **Resume:** a second `snapshot` with the same ids does not remount rows; an item update (`tool_call` completes) changes in place.
- **Markdown:** `<script>` in a message renders as text; links get `rel`; code block copy.
- **Screen item:** renders ANSI colour spans; capped with "Show all".

## Built

On `feat/v2-web`. The timeline adopts T3 Code's timeline (e3b35d1b) rather than the row model above, so later T3 releases
can be diffed in. Files follow T3's layout and are listed in `web2/t3-upstream.json`:

- `components/chat/MessagesTimeline.logic.ts` (adapted): T3's row kinds `message`, `work` (one entry, or a group's
  details), `work-toggle` (group header), `work-live` (the running tool), `working` (header of the active turn), `thinking`
  (live tail), `turn-fold` ("Worked for 1m 3s" over a settled run's work), `assistant-meta`, `event`; plus Sightr's `day`.
  Left out: worktree setup, superseded attempts, subagents, plans, MCP apps, HTML renders, compaction, diffs, minimap.
- `session-logic.ts` (adapted): turn items → T3 timeline/work-log entries. Sightr adds the run-end notices and reasoning
  durations. `t3/client-runtime/work-log/presentation.ts`, `t3/shared/toolActivity.ts`, `t3/shared/orchestrationTiming.ts`
  (adapted) and `t3/shims/{commandLabel,toolOutput}.ts` sit behind `@t3tools/...` aliases in `t3-shims.ts` and tsconfig.
- `components/chat/MessagesTimeline.tsx` (adapted), `WorkLog.tsx` and `TimelineSystemDivider.tsx` (verbatim),
  `MessageCopyButton.tsx` and `components/ChatMarkdown.tsx` (adapted), `ToolItemDetail.tsx` (pattern of V2ItemInspector),
  `ScreenTimelineRow.tsx`, `useTimelineFollow.ts`, `state/timeline.ts` (folds, groups, history paging, `followTimeline()`),
  `stream/apply.ts` `mergeHistoryPage`.
- `@legendapp/list` 3.3.5 (T3's pin; T3's patch only touches the React Native keyboard files). Markdown is
  `react-markdown` 10.1.0 + `remark-gfm` 4.0.1 + `remark-breaks` 4.0.0 (T3's versions).

Deviations from the text above:
- Files live in `components/chat/` and `components/ChatMarkdown.tsx` (T3 names), not `components/timeline/`; there is
  no `buildRows`; `deriveMessagesTimelineRows` is the pure function and its tests cover the listed cases.
- Tool kinds are T3's (`command_execution`, `file_change`, `file_search`, `web_search`, `dynamic_tool`), not `toolKind`.
  Group labels are T3's `summarizeToolGroup`: the two leading actions, then "performed N other actions"
  ("Ran 2 commands, changed 1 file, and performed 3 other actions"), and "changed" rather than "edited".
- Reasoning is not its own row kind: as in T3 it is an entry in the work log, so a thought groups with the tools around
  it. Its label carries the spec's duration ("Thought for 12s", "Thought briefly", "Thought"), with a preview of the text;
  a live thought reads "Thinking…" with a ticking time. Thinking time uses the item's start/end, else the gap to the next
  item in the run (under 10 min, not a user message, not a sibling part of the same journal entry).
- Groups follow T3: collapsed by default and opened by the operator (state per thread, kept across updates). While a
  run works its running tool is the `work-live` row (never folded) instead of an auto-expanded group. A failed tool
  entry opens itself and uses warn tokens, and its group header turns warn; the group itself is not auto-opened.
- The run banner is T3's `working` row, at the top of the active turn ("Working for 1m 24s", plus "· 2 queued" or
  "Waiting for you"), with T3's "Thinking" tail at the bottom; not a last row. Stopped and failed runs get a synthetic
  notice item (`run-end:<runId>`); a run has no reason field, so the failed notice points at the Terminal tab.
- Markdown is T3's `ChatMarkdown` structure on react-markdown, not `@v1/lib/markdown`. Left out: Shiki highlighting,
  Mermaid, raw HTML (shown as text instead of sanitized), file links/chips, images (an image becomes a link), citations,
  skill chips, GitHub alerts, task-list toggling. Only http(s) and mailto links are links.
- An expanded tool group is a bounded scrolling list, not T3's nested LegendList. Tool output is cut at 200 lines with
  a note; a journal-truncated item says so. A tool with nothing beyond its label (no output recorded) has no toggle.
- Follow mode re-arms within 80 px (T3 uses 40). The anchor on history prepend and snapshot replacement is LegendList's
  `maintainVisibleContentPosition` (rows are keyed by item id); tests check rows are not remounted, not pixel offsets.
- The screen item shows its last 40 lines (the tail of a screen is the useful part), with "Show all".
- Live check: a scratch bridge (port 8790) against the herd; the coordinator's Claude thread rendered messages, grouped
  tool calls with output, thinking rows, "Start of thread", the working header and the Jump-to-latest pill. That thread's
  window held 50 items and no user message (T03's first read keeps the last 50 entries).
- Blank-list guard (19 Oct 2026, `useBlankViewportGuard.ts`). A phone showed the list as a gap after a send, with the text pages
  above it, until the thread was left and re-entered. `MessagesTimeline` now looks every 500 ms for a row, header or footer frame
  touching the scroller's visible band; two looks in a row with none, with no scroll or touch for 400 ms, rebuild the
  `LegendList` (a `key` bump, `data-list-generation` on the timeline) and re-follow. Hidden pages, a scroller with no size and a
  list that has drawn nothing are skipped, and a rebuild is followed by a 5 s cooldown. Tests: `useBlankViewportGuard.test.ts`
  (the rules) and `MessagesTimeline.test.tsx` "blank list" (a gap is rebuilt; a healthy list is not). The trigger was not found,
  so the guard is a symptom repair; `@legendapp/list` stays on 3.3.5 (T3's pin) and 3.3.9+ is the next lead.
