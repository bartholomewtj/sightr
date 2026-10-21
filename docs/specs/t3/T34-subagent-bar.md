# T34 — Subagent bar: every subagent of a thread in one place above the composer

Status: built 21 Oct 2026 (interview with Bart). Depends on: T32 (merged agents, `lib/subagentGroups.ts`) and T33 (agent transcripts: `?latest=1` activity, `TranscriptPane`). Web2 only: no bridge or `shared/` change.

## Problem

T32's cards sit in the chat where the work happened, and T33's transcript opens from them. With several agents over several runs there is no single place to see them all or to watch one without scrolling to its card. The Tasks bar above the composer is the model: always in reach, one line when closed.

## Choices (Bart, 21 Oct)

- **Scope:** this thread, all (loaded) runs; running agents first, then newest.
- **Collapsed strip:** counts plus the newest activity of a running agent ("Running: git status").
- **Expanded:** in place above the composer, a list that scrolls (not a sheet).
- **Tapping an agent:** its own view, opening on the live transcript, with a back arrow to the list.
- **Chat cards:** unchanged. **With Tasks:** two bars, the Subagents bar directly above the Tasks bar.
- **Finished agents:** stay, dimmed; a Hide finished / Show finished toggle in the list (first built as "Clear finished", changed 21 Oct at Bart's request: nothing is removed, the list shows only running agents while hidden, remembered per thread on the device). **Alert:** a dot on the bar when an agent finishes or fails since the list was last open (red for a failure).

## Change

- `lib/subagentGroups.ts` `deriveThreadAgents(items)`: one `ThreadAgent {key, item (merged), phase, lastAt}` per agent over all loaded items; running first, then newest.
- `lib/subagentBarState.ts` `useSubagentBarState(threadId, agents, newestItemAt)`: per thread, per device, in `localStorage` (`sightr:v2:subagents-hide-finished:<thread>`, `…-seen:<thread>` with 400 entries kept). The first time a thread's items are loaded on a device, the time of its newest item is kept as a baseline (`…-baseline:<thread>`); only an agent whose newest call is later can light the dot. (The first build marked "everything finished at first sight" as seen; older runs load after the first render, so history lit the dot. Found on the live Firelight thread.) Opening the list, and anything that finishes while it is open, marks seen.
- `components/chat/ComposerSubagentsBar.tsx`, rendered by `ChatComposer` before the Tasks block (`ComposerBanner` parts, 44 px rows on touch). Strip: icon (+ dot), "Subagents", the lead running agent's `?latest=1` line (polled every 6 s while it is on screen) or the count line, a count ("2 running", else "1 failed", else "3 done"). List: a header with the count line and the Hide/Show finished toggle (the strip's counts always cover every agent); rows with status dot, name, status, elapsed, and a second line (activity, progress, report or brief). Hidden when the thread has no subagents.
- `components/chat/SubagentAgentSheet.tsx`: the agent's own view, a tall bottom sheet on a phone (one history entry, so Back closes it and the list stays open under it) and a side sheet on desktop. Tabs Transcript | Details; a running agent with a log opens on the transcript, anything else on the details (`SubagentDetail`, now exported, with `flush`); an agent with no log has no tabs and says so. `TranscriptPane` was extracted from T33's sheet so both use one live list.

## Not here

Agents of runs that are not loaded (history paging) are not in the list; the bar reads the thread's loaded items. Dismissals are per device. No bridge-side unread state.

## Done when

Tests: `ComposerSubagentsBar.test.tsx` (strip, activity, list order, Hide/Show finished and its memory, dot on finish and on failure, no dot for history, detail view and back, finished agent on details), `subagentGroups.test.ts` (`deriveThreadAgents`). Checked in a 390 px page on a real thread.
