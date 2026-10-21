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
- **Finished agents:** stay, dimmed, until "Clear finished". **Alert:** a dot on the bar when an agent finishes or fails since the list was last open (red for a failure).

## Change

- `lib/subagentGroups.ts` `deriveThreadAgents(items)`: one `ThreadAgent {key, item (merged), phase, lastAt}` per agent over all loaded items; running first, then newest.
- `lib/subagentBarState.ts` `useSubagentBarState(threadId, agents)`: per thread, per device, in `localStorage` (`sightr:v2:subagents-dismissed:<thread>`, `…-seen:<thread>`, 400 entries kept). A thread's first sight on a device marks what has already finished as seen, so history never lights the dot. Opening the list, and anything that finishes while it is open, marks seen.
- `components/chat/ComposerSubagentsBar.tsx`, rendered by `ChatComposer` before the Tasks block (`ComposerBanner` parts, 44 px rows on touch). Strip: icon (+ dot), "Subagents", the lead running agent's `?latest=1` line (polled every 6 s while it is on screen) or the count line, a count ("2 running", else "1 failed", else "3 done"). List: a header with the count line and Clear finished; rows with status dot, name, status, elapsed, and a second line (activity, progress, report or brief). Hidden when the thread has no subagents.
- `components/chat/SubagentAgentSheet.tsx`: the agent's own view, a tall bottom sheet on a phone (one history entry, so Back closes it and the list stays open under it) and a side sheet on desktop. Tabs Transcript | Details; a running agent with a log opens on the transcript, anything else on the details (`SubagentDetail`, now exported, with `flush`); an agent with no log has no tabs and says so. `TranscriptPane` was extracted from T33's sheet so both use one live list.

## Not here

Agents of runs that are not loaded (history paging) are not in the list; the bar reads the thread's loaded items. Dismissals are per device. No bridge-side unread state.

## Done when

Tests: `ComposerSubagentsBar.test.tsx` (strip, activity, list order, Clear finished and its memory, dot on finish and on failure, no dot for history, detail view and back, finished agent on details), `subagentGroups.test.ts` (`deriveThreadAgents`). Checked in a 390 px page on a real thread.
