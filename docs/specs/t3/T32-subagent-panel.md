# T32 — Subagent panel: one grouped card per run, with the brief, a friendly name and a result card

Status: built 21 Oct 2026 (interview with Bart). Build amendments at the end. Depends on: the v2 timeline (`MessagesTimeline.tsx`, `session-logic.ts`) and the `subagent` turn item (`shared/v2/contracts.ts`). Sibling: T33 (live transcript); do not build it here. Pi and Claude together.

## Problem

A subagent is drawn as one row per tool call (`V2LifecycleRow.tsx` `SubagentRow`). Three things go wrong:

1. **No grouping.** Five subagents in a run are five separate rows scattered between messages.
2. **Calls are not joined to their launch.** Pi's `get_subagent_result` carries only `agent_id`, so its row has no brief and its title is the bare id (`fd9eec52-cc41-447`). Claude joins a hand-back to its call by agent id (`bridge/journal/claude.ts` `subagentsByAgent`); Pi's journal does not (`bridge/journal/pi.ts` `piCallDetail`, `applyPiDetails`). 21 Oct: such a row opened to nothing (fixed in PR #124 by always saying something; this slice fixes the cause).
3. **The result is a wall of markdown** inside a 28 rem scroller.

## Choices (Bart, 21 Oct)

- Layout: **one grouped "Subagents" panel per run**, a count line ("3 running · 2 done"), each agent an expandable row. Not a pinned tray, not tidied inline rows.
- Detail: the **original brief up front**, a **friendly name** (task description, id small underneath), the **result as a summary card**. Not chosen: a jump-to-terminal button.
- Scope: **Pi and Claude** in one slice; Codex and Grok keep today's row.

## Change

- **Bridge, join by agent id** (`bridge/journal/pi.ts`, same pattern as Claude): remember the launch call (`subagent`, whose result details carry `agentId`, `description`, `modelName`) by agent id; fold a later `get_subagent_result` / `steer_subagent` onto it, or at minimum copy the launch's `title` and `prompt` onto the result call's detail. One agent = one `subagent` item with `subagentId` stable across calls. Check how `turn-items.ts` (`detail.kind === "subagent"`) would then see two parts for one agent and keep the later status/result on the first.
- **Contract:** `subagent` item gains `launchedAt?` and `name` is the item `title` (task description); `subagentId` stays the agent id. Mirror T3's shape; extra fields are Sightr-only and commented as such.
- **Grouping** (`web2/src/session-logic.ts` + `MessagesTimeline.logic.ts`): the consecutive-or-same-run `subagent` items of one run fold into one `subagent_group` timeline row placed at its first member; members keep their ids for `data-timeline-row-id`. Pure function with tests (ordering, one agent → still a group of one, a run with none → no row).
- **Group UI** (`V2LifecycleRow.tsx` or a new `SubagentGroupRow.tsx`): header "Subagents" with status counts; collapsed shows a one-line row per agent (name, status dot, elapsed, model chip); a running agent is open by default only when it is the sole one. Rows 44 px on a coarse pointer. Expanded agent: facts line (status, model, tokens, tools, id small), **Brief** (collapsed `details`, first line visible), **Result card** (collapsed to ~6 lines with "Show all", Copy button, truncation note), failure text in the destructive colour. Status words follow `subagentStatusLabel`; add Pi's `error`/`stopped`.
- **No harness-id branching in web2** (`scripts/web2-harness-ids.ts`): everything above reads the item.

## Not here

Live transcript (T33). Steering a subagent from the phone. Codex/Grok mapping.

## Done when

Pi `subagent` + `get_subagent_result` pairs on disk (use a real session from `~/.pi/agent/sessions`, as a trimmed fixture) produce one item per agent with the task name and brief; a Claude run with three subagents draws one group with correct counts; the blank-row case from 21 Oct cannot recur (test); web2 and bridge suites and typechecks pass; checked in a 390 px page.

## Build amendments

- **The join is in web2, not the Pi journal.** The bridge parses a log in windows, so a launch can sit in an earlier window than its check-on call; `web2/src/lib/subagentGroups.ts` joins by `subagentId` over the whole thread. The bridge only cleans Pi's `get_subagent_result` text (`cleanSubagentResult` in `bridge/journal/pi.ts`: header, transcript footer and "still running" removed) and carries its `Progress:` line as the item's `progress`.
- **An agent checked in a later run has a card in that run too**, named and briefed from its launch; the launch's own card keeps its row. Items of one agent within a run are one row.
- A sole running agent opens by itself. The brief is shown clamped (Show all), not behind a tap. Card code: `SubagentGroup.tsx`; `V2LifecycleRow` draws a lone item as a card of one.
- `transcriptPath` is present on a **running** Pi agent's `get_subagent_result` details (checked in 21 Oct session files), which settles T33's open question.

