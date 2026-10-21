// T32: one card per run for its subagents, one row per agent.
//
// The journals give one `subagent` item per tool call, and an agent can have several: Pi's `subagent`
// launches it and `get_subagent_result` (maybe in a later run) checks on it; Claude's call is later
// updated by a hand-back. A check-on call carries only the agent id, so its row used to be a bare id with
// no brief (21 Oct 2026). Items of one agent are joined here by `subagentId`, over the whole thread, because
// the bridge parses a log in windows and a launch can sit in an earlier one. Pure and harness-blind.

import type { TurnItem } from "@shared/v2/contracts";

export type SubagentItem = Extract<TurnItem, { type: "subagent" }>;

/** How a card counts an agent. `running` includes a background agent whose launching call has returned. */
export type SubagentPhase = "running" | "done" | "failed" | "stopped";

const RUNNING_WORDS = new Set(["running", "background", "async_launched"]);

/** The agent's real id, or null when the item only has the journal's synthetic `<call>:<index>` key. */
export function realAgentId(item: SubagentItem): string | null {
  const id = item.subagentId?.trim();
  return id && !id.includes(":") ? id : null;
}

export function subagentPhase(item: SubagentItem): SubagentPhase {
  const word = item.agentStatus?.toLowerCase();
  if (item.status === "failed" || word === "error" || word === "failed") return "failed";
  if (item.status === "cancelled" || item.status === "interrupted") return "stopped";
  if (word !== undefined && RUNNING_WORDS.has(word)) return "running";
  if (item.status === "pending" || item.status === "running" || item.status === "waiting") return "running";
  return "done";
}

/** A title worth showing: not empty, and not just the agent id the check-on call was summarised as. */
function meaningfulTitle(item: SubagentItem): string | null {
  const title = item.title?.trim();
  if (!title) return null;
  const id = realAgentId(item);
  if (id && title.includes(id)) return null;
  if (title === "Subagent") return null;
  return title;
}

/** A report only counts when the agent has finished: a launch's "started in the background" is not one. */
function carriesReport(item: SubagentItem): boolean {
  if ((item.result?.trim() ?? "") === "") return false;
  const word = item.agentStatus?.toLowerCase();
  return word === undefined || !RUNNING_WORDS.has(word);
}

/** The items of one agent, oldest first, as one: the launch's brief and name, the latest state and report. */
export function mergeSubagentItems(items: readonly SubagentItem[]): SubagentItem {
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (items.length === 1) return first;
  let title: string | undefined;
  let prompt = "";
  let model: string | null | undefined;
  let progress: string | undefined;
  let durationMs: number | undefined;
  let tokens: string | undefined;
  let toolUses: number | undefined;
  let result: string | null = null;
  let agentStatus: string | undefined;
  for (const item of items) {
    title ??= meaningfulTitle(item) ?? undefined;
    if (prompt === "" && item.prompt.trim() !== "") prompt = item.prompt;
    if (item.model) model = item.model;
    if (item.agentStatus) agentStatus = item.agentStatus;
    if (item.durationMs !== undefined) durationMs = item.durationMs;
    if (item.tokens) tokens = item.tokens;
    if (item.toolUses !== undefined) toolUses = item.toolUses;
    if (carriesReport(item)) result = item.result;
  }
  // Progress belongs to the latest look only: an older "thinking…" is stale once the agent finished.
  if (last.progress?.trim()) progress = last.progress;
  const merged: SubagentItem = {
    ...last,
    id: first.id,
    prompt,
    result,
    startedAt: first.startedAt ?? first.createdAt,
    ...(title !== undefined ? { title } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(agentStatus !== undefined ? { agentStatus } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
  };
  if (progress === undefined) delete merged.progress;
  else merged.progress = progress;
  if (items.some((i) => i.truncated)) merged.truncated = true;
  return merged;
}

export interface SubagentGroupPlan {
  /** First member's item id of each run's group → that group's agents, in launch order. */
  readonly anchors: ReadonlyMap<string, readonly SubagentItem[]>;
  /** Every other subagent item of a group: drawn inside the card, not as a row of its own. */
  readonly hidden: ReadonlySet<string>;
}

/**
 * Plan the cards for a thread's items (in order). One group per run; an agent is in the group of every
 * run that has one of its items, drawn with all it is known to be so far.
 */
export function planSubagentGroups(items: readonly TurnItem[]): SubagentGroupPlan {
  const byAgent = new Map<string, SubagentItem[]>();
  const all: SubagentItem[] = [];
  for (const item of items) {
    if (item.type !== "subagent") continue;
    all.push(item);
    const id = realAgentId(item);
    if (id) {
      const list = byAgent.get(id);
      if (list) list.push(item);
      else byAgent.set(id, [item]);
    }
  }
  const anchors = new Map<string, SubagentItem[]>();
  const hidden = new Set<string>();
  const groupOfRun = new Map<string, { anchor: string; keys: Set<string>; agents: SubagentItem[] }>();
  for (const item of all) {
    const runKey = item.runId ?? "";
    let group = groupOfRun.get(runKey);
    if (!group) {
      group = { anchor: item.id, keys: new Set(), agents: [] };
      groupOfRun.set(runKey, group);
      anchors.set(item.id, group.agents);
    } else {
      hidden.add(item.id);
    }
    const id = realAgentId(item);
    const key = id ?? item.id;
    if (group.keys.has(key)) continue;
    group.keys.add(key);
    group.agents.push(mergeSubagentItems(id ? byAgent.get(id)! : [item]));
  }
  return { anchors, hidden };
}

export interface SubagentCounts {
  readonly total: number;
  readonly running: number;
  readonly done: number;
  readonly failed: number;
  readonly stopped: number;
}

export function countSubagents(agents: readonly SubagentItem[]): SubagentCounts {
  const counts = { total: agents.length, running: 0, done: 0, failed: 0, stopped: 0 };
  for (const agent of agents) counts[subagentPhase(agent)] += 1;
  return counts;
}

/** "3 running · 2 done · 1 failed": the nonzero counts, running first. */
export function subagentCountLine(counts: SubagentCounts): string {
  const parts: string[] = [];
  if (counts.running) parts.push(`${counts.running} running`);
  if (counts.done) parts.push(`${counts.done} done`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.stopped) parts.push(`${counts.stopped} stopped`);
  return parts.join(" · ");
}

/** Cheap structural equality for the timeline's row memo: merged items are rebuilt on every derivation. */
export function sameSubagents(a: readonly SubagentItem[] | undefined, b: readonly SubagentItem[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return (
      x.id === y.id &&
      x.status === y.status &&
      x.agentStatus === y.agentStatus &&
      x.title === y.title &&
      x.prompt === y.prompt &&
      x.result === y.result &&
      x.progress === y.progress &&
      x.model === y.model &&
      x.tokens === y.tokens &&
      x.toolUses === y.toolUses &&
      x.durationMs === y.durationMs &&
      x.updatedAt === y.updatedAt
    );
  });
}
