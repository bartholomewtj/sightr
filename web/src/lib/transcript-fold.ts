// Folds consecutive tool-only assistant entries and calculates thinking duration.
// Cross-entry grouping needs the whole entry list and timestamps, plus a tool-name-to-verb table;
// that is pure logic, not layout, so it lives here and can be tested without rendering.
// Grok writes many tool_calls on one assistant row, often with a spoken line in front — those tools
// are peeled off so they fold the same way as Claude's one-tool-per-entry rows.
// foldLabel composes plain strings from tool names only and never emits markup (same XSS boundary as the view).

import type { TranscriptEntry, TranscriptPart } from "./types";

export type FoldTool = Extract<TranscriptPart, { kind: "tool" }>;

export type FoldItem =
  | { kind: "turn"; key: string; entry: TranscriptEntry; index: number }
  | { kind: "divider"; key: string; day: string }
  | { kind: "fold"; key: string; entries: TranscriptEntry[]; tools: FoldTool[] };

function dayKey(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function isPadding(part: TranscriptPart): boolean {
  return part.kind === "text" && part.text.trim() === "";
}

function toolParts(entry: TranscriptEntry): FoldTool[] {
  return entry.parts.filter((p): p is FoldTool => p.kind === "tool");
}

/** Spoken / thinking parts. Empty text is padding and does not count. */
function speechParts(entry: TranscriptEntry): TranscriptPart[] {
  return entry.parts.filter((p) => p.kind !== "tool" && !isPadding(p));
}

/** A tool-only assistant entry. Claude Code writes one tool per entry, so a round of six is six
 *  entries; these are what a fold collapses. Grok often puts a spoken preamble on the same row as
 *  the tool_calls — those tools still fold; the preamble is a turn in front. Empty / whitespace
 *  text is padding. A thinking part is speech: it splits the run, then any tools on that row fold
 *  with the tools that follow. */
function isToolOnly(entry: TranscriptEntry): boolean {
  return entry.role === "assistant" && toolParts(entry).length > 0 && speechParts(entry).length === 0;
}

export function foldEntries(entries: TranscriptEntry[]): FoldItem[] {
  const out: FoldItem[] = [];
  let lastDay = "";
  let run: TranscriptEntry[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const tools: FoldTool[] = [];
    for (const e of run) {
      for (const p of e.parts) {
        if (p.kind === "tool") {
          tools.push(p);
        }
      }
    }
    if (tools.length > 0) {
      out.push({
        kind: "fold",
        key: `fold:${run[0]!.uuid}`,
        entries: run,
        tools,
      });
    }
    run = [];
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const day = dayKey(entry.ts);
    const newDay = day !== "" && day !== lastDay;

    if (newDay) {
      flush();
      out.push({
        kind: "divider",
        key: `day:${day}:${entry.uuid}`,
        day,
      });
      lastDay = day;
    }

    if (isToolOnly(entry)) {
      run.push(entry);
      continue;
    }

    const tools = entry.role === "assistant" ? toolParts(entry) : [];
    if (tools.length > 0) {
      flush();
      out.push({
        kind: "turn",
        key: entry.uuid,
        entry: { ...entry, parts: speechParts(entry) },
        index: i,
      });
      run.push({ ...entry, parts: tools });
      continue;
    }

    flush();
    out.push({
      kind: "turn",
      key: entry.uuid,
      entry,
      index: i,
    });
  }

  flush();
  return out;
}

interface BucketInfo {
  verb: string;
  nounSingular: string;
  nounPlural: string;
  count: number;
}

export function foldLabel(tools: readonly { name: string }[]): string {
  if (tools.length === 0) return "";

  const buckets = new Map<string, BucketInfo>();

  for (const tool of tools) {
    const name = tool.name.toLowerCase();
    let key: string;
    let verb: string;
    let nounSingular: string;
    let nounPlural: string;

    if (["bash", "shell", "run_command", "execute", "powershell", "run_terminal_command"].includes(name)) {
      key = "commands";
      verb = "ran";
      nounSingular = "command";
      nounPlural = "commands";
    } else if (name === "read" || name === "read_file") {
      key = "files";
      verb = "read";
      nounSingular = "file";
      nounPlural = "files";
    } else if (["grep", "glob", "list_dir"].includes(name)) {
      key = "searches";
      verb = "searched";
      nounSingular = "file";
      nounPlural = "files";
    } else if (["edit", "write", "multiedit", "notebookedit", "search_replace"].includes(name)) {
      key = "edits";
      verb = "edited";
      nounSingular = "file";
      nounPlural = "files";
    } else {
      key = `other:${name}`;
      verb = "made";
      nounSingular = `${name} call`;
      nounPlural = `${name} calls`;
    }

    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      buckets.set(key, { verb, nounSingular, nounPlural, count: 1 });
    }
  }

  const phrases: string[] = [];
  for (const b of buckets.values()) {
    const noun = b.count === 1 ? b.nounSingular : b.nounPlural;
    phrases.push(`${b.verb} ${b.count} ${noun}`);
  }

  const joined = phrases.join(", ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** Seconds between a thinking entry and the entry that followed it — how long the agent thought.
 *  Null when there is no next entry (it is still thinking, or the log ends here) or either
 *  timestamp is missing / unparseable, so the caller can say "Thinking" instead of a wrong number. */
export function thinkingDuration(entries: TranscriptEntry[], index: number): number | null {
  if (index < 0 || index + 1 >= entries.length) return null;
  const currentTs = entries[index]?.ts;
  const nextTs = entries[index + 1]?.ts;
  if (!currentTs || !nextTs) return null;
  const current = new Date(currentTs).getTime();
  const next = new Date(nextTs).getTime();
  if (Number.isNaN(current) || Number.isNaN(next)) return null;
  const diffMs = next - current;
  if (diffMs < 0) return null;
  return Math.round(diffMs / 1000);
}
