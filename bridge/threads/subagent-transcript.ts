// A subagent's own conversation: `GET /api/v2/thread/:threadId/item/:itemId/transcript` (spec T33).
//
// Both harnesses write each child agent's log to disk, in their ordinary journal format:
//  - Claude: `<project dir>/<session id>/subagents/agent-<agentId>.jsonl` (rows marked `isSidechain`);
//  - Pi: `<project dir>/<session>/tasks/<ts>_<uuid>.jsonl`, named only by `get_subagent_result`'s
//    `details.transcriptPath` (the file carries no agent id).
// This route parses that log with the harness's own adapter and answers in the thread's item shape.
//
// What it will and will not read, because a log is hostile input (the attachment route's rules):
//  - the client names a thread and an ITEM, never a path. The item comes from the store, and the path is
//    built from it: Claude's from the item's agent id (checked against a strict pattern) and the thread's
//    own log directory; Pi's from the `transcriptPath` the journal recorded on the agent's items;
//  - either path must be a `.jsonl` file whose real path lies inside the thread's own log directory
//    (`dirname` of the session log the ingest follows), after symlinks;
//  - only the tail of the file is read (`tailBytes`), and at most `maxItems` items are returned, so a
//    long-running agent costs a bounded read per poll;
//  - `?size=<n>` makes an unchanged file a tiny `{unchanged: true}` answer, which is what a live view polls.

import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { TurnItem } from "../../shared/v2/contracts.ts";
import { containedRealpath } from "../containment.ts";
import { parseClaudeTranscript } from "../journal/claude.ts";
import { parsePiTranscript } from "../journal/pi.ts";
import type { TranscriptEntry } from "../journal/types.ts";
import type { ThreadStore } from "./store.ts";
import { entryItems } from "./turn-items.ts";

export const TRANSCRIPT_ROUTE = /^\/api\/v2\/thread\/([^/]+)\/item\/([^/]+)\/transcript$/;
/** The newest bytes of the log a full read parses. */
export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
/** The smaller window `?latest=1` reads: it needs only the last line. */
export const TRANSCRIPT_LATEST_BYTES = 256 * 1024;
export const TRANSCRIPT_MAX_ITEMS = 300;
/** Items of one thread scanned to find an agent's other calls (Pi's path arrives on a later check). */
const SCAN_ITEMS = 4000;

/** Claude's agent ids are short hex; a Pi id has dashes. Nothing else may reach a file name. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface TranscriptDeps {
  store: Pick<ThreadStore, "getTurnItem" | "recentItems" | "offsets">;
  now?: () => number;
  tailBytes?: number;
  latestBytes?: number;
  maxItems?: number;
}

export interface LatestActivity {
  /** "Running", "Edited", "Thinking"…: what kind of thing it was. */
  label: string;
  /** One line: the command, the path, the first words said. */
  text: string;
}

export type TranscriptBody =
  | { ok: true; unchanged: true; size: number }
  | {
      ok: true;
      size: number;
      /** The agent is still working, as of its newest item in this thread. */
      running: boolean;
      /** The log's older part was cut: the view starts partway. */
      cutHead: boolean;
      items: TurnItem[];
    }
  | { ok: true; latest: LatestActivity | null; size: number; running: boolean; toolCount: number };

export type TranscriptResult =
  | { ok: true; body: TranscriptBody }
  | { ok: false; status: 404; reason: string };

const missing = (reason: string): TranscriptResult => ({ ok: false, status: 404, reason });

type SubagentItem = Extract<TurnItem, { type: "subagent" }>;

const RUNNING_WORDS = new Set(["running", "background", "async_launched"]);

function isRunning(item: SubagentItem): boolean {
  const word = item.agentStatus?.toLowerCase();
  if (item.status === "failed" || item.status === "cancelled" || item.status === "interrupted") return false;
  if (word !== undefined) return RUNNING_WORDS.has(word);
  return item.status === "running" || item.status === "pending" || item.status === "waiting";
}

/** Every item of this agent in the thread, oldest first (a launch and its later checks). */
function agentItems(deps: TranscriptDeps, item: SubagentItem): SubagentItem[] {
  const all = deps.store.recentItems(item.threadId, SCAN_ITEMS);
  const same = all.filter((i): i is SubagentItem => i.type === "subagent" && i.subagentId === item.subagentId);
  return same.length > 0 ? same.sort((a, b) => a.ordinal - b.ordinal) : [item];
}

/** Claude: the agent's log under the session directory that launched it (this one, else a sibling). */
async function claudePath(mainLog: string, agentId: string): Promise<string | null> {
  if (!AGENT_ID.test(agentId)) return null;
  const projectDir = dirname(mainLog);
  const file = `agent-${agentId}.jsonl`;
  const own = join(projectDir, basename(mainLog, ".jsonl"), "subagents", file);
  const hit = await containedRealpath(own, projectDir);
  if (hit) return hit;
  // After /clear or /new the thread follows a newer session, but the agent ran in an earlier one.
  let names: string[];
  try {
    names = await readdir(projectDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (name.toLowerCase().endsWith(".jsonl")) continue;
    const found = await containedRealpath(join(projectDir, name, "subagents", file), projectDir);
    if (found) return found;
  }
  return null;
}

/** Pi: the path the journal recorded, if it really is a log inside the thread's own directory. */
async function piPath(mainLog: string, recorded: string | undefined): Promise<string | null> {
  if (!recorded || !recorded.toLowerCase().endsWith(".jsonl")) return null;
  return containedRealpath(recorded, dirname(mainLog));
}

function toItems(entries: readonly TranscriptEntry[], item: SubagentItem, running: boolean, now: number): TurnItem[] {
  const out: TurnItem[] = [];
  for (const entry of entries) {
    const drafts = entryItems(entry, {
      threadId: item.threadId,
      runId: null,
      runOpen: running,
      createdAt: now,
      updatedAt: now,
      harness: item.driver,
    });
    for (const draft of drafts) out.push({ ...draft, ordinal: out.length } as TurnItem);
  }
  return out;
}

function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The newest thing the agent did, as a label and a line. Messages and thinking rank below tool calls only by recency. */
export function latestActivity(items: readonly TurnItem[]): LatestActivity | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    switch (it.type) {
      case "assistant_message":
        if (it.text.trim()) return { label: "Said", text: oneLine(it.text) };
        break;
      case "reasoning":
        return { label: "Thinking", text: oneLine(it.text) };
      case "command_execution":
        return { label: "Running", text: oneLine(it.input) };
      case "file_change":
        return { label: "Editing", text: it.fileName };
      case "file_search":
        return { label: "Searching", text: oneLine(it.pattern ?? "files") };
      case "web_search":
        return { label: "Searching the web", text: oneLine((it.patterns ?? []).join(", ")) };
      case "dynamic_tool": {
        const arg = typeof it.input === "string" ? it.input : "";
        return { label: it.toolName?.trim() || "Tool", text: oneLine(arg) };
      }
      case "todo_list":
        return { label: "Updated tasks", text: `${it.steps.filter((s) => s.status === "completed").length}/${it.steps.length} done` };
      default:
        break;
    }
  }
  return null;
}

const TOOL_TYPES = new Set<TurnItem["type"]>(["command_execution", "file_change", "file_search", "web_search", "dynamic_tool"]);

export interface TranscriptReader {
  load(threadId: string, itemId: string, query: { size?: number; latest?: boolean }): Promise<TranscriptResult>;
}

export function createTranscriptReader(deps: TranscriptDeps): TranscriptReader {
  const now = deps.now ?? Date.now;
  const tailBytes = deps.tailBytes ?? TRANSCRIPT_TAIL_BYTES;
  const latestBytes = deps.latestBytes ?? TRANSCRIPT_LATEST_BYTES;
  const maxItems = deps.maxItems ?? TRANSCRIPT_MAX_ITEMS;
  return {
    async load(threadId, itemId, query) {
      const item = deps.store.getTurnItem(itemId);
      if (!item || item.threadId !== threadId || item.type !== "subagent") return missing("no-such-agent");
      const mainLog = deps.store.offsets.get(threadId)?.path;
      if (!mainLog) return missing("no-session-log");
      const same = agentItems(deps, item);
      const running = isRunning(same[same.length - 1]!);
      const harness = item.driver;

      let path: string | null;
      if (harness === "claude") {
        path = await claudePath(mainLog, item.subagentId);
      } else if (harness === "pi") {
        const recorded = [...same].reverse().find((i) => i.transcriptPath)?.transcriptPath;
        path = await piPath(mainLog, recorded);
      } else {
        return missing("unsupported-harness");
      }
      if (path === null) return missing("no-transcript");

      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        return missing("no-transcript");
      }
      if (query.size !== undefined && query.size === size && !query.latest) return { ok: true, body: { ok: true, unchanged: true, size } };

      const window = query.latest ? latestBytes : tailBytes;
      const start = Math.max(0, size - window);
      const text = await Bun.file(path).slice(start, size).text();
      const entries =
        harness === "claude" ? parseClaudeTranscript(text, { includeSidechains: true }) : parsePiTranscript(text);
      const items = toItems(entries, item, running, now());

      if (query.latest) {
        return {
          ok: true,
          body: { ok: true, latest: latestActivity(items), size, running, toolCount: items.filter((i) => TOOL_TYPES.has(i.type)).length },
        };
      }
      const kept = items.length > maxItems ? items.slice(-maxItems) : items;
      return { ok: true, body: { ok: true, size, running, cutHead: start > 0 || kept.length < items.length, items: kept } };
    },
  };
}
