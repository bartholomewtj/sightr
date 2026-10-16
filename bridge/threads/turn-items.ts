import type { FileSearchResult, TurnItem, TurnItemStatus } from "../../shared/v2/contracts.ts";
import type { TranscriptEntry, TranscriptPart } from "../journal/types.ts";
import type { TurnItemDraft } from "./events.ts";

// Journal entries → v2 turn items (T03). Pure: no store, no clock, no fs.
//
// One item per part of an entry, with the id `<entry key>:<part index>`, so an item keeps its id
// however the log is windowed, re-parsed or re-read after a restart. Item kinds follow T3 Code's
// `OrchestrationV2TurnItem`; a tool call becomes the T3 kind its name implies (`toolItemType`).

/** The T3 item kinds a journal tool call can map to. */
export type ToolItemType = "command_execution" | "file_change" | "file_search" | "web_search" | "dynamic_tool";

/**
 * Tool name (lower-cased) → T3 item kind. Anything not listed, `read` included, is a `dynamic_tool`.
 * Names come from Claude (`Bash`, `Edit`, …), Pi (`bash`, `edit`, …), Cursor (`Shell`, …), Grok
 * (`run_terminal_command`, `read_file`, …) and Codex (`shell_command`, `exec_command`, `apply_patch`, …).
 * The test pins it against every adapter fixture's names.
 */
export const TOOL_ITEM_TYPES: Readonly<Record<string, ToolItemType>> = {
  bash: "command_execution",
  shell: "command_execution",
  exec: "command_execution",
  run_command: "command_execution",
  run_terminal_cmd: "command_execution",
  run_terminal_command: "command_execution",
  powershell: "command_execution",
  // Codex (T16): its shell tools by every name a rollout records.
  shell_command: "command_execution",
  exec_command: "command_execution",
  write_stdin: "command_execution",

  edit: "file_change",
  multiedit: "file_change",
  write: "file_change",
  notebookedit: "file_change",
  apply_patch: "file_change",
  str_replace: "file_change",
  search_replace: "file_change",
  edit_file: "file_change",
  write_file: "file_change",

  grep: "file_search",
  glob: "file_search",
  find: "file_search",
  search: "file_search",
  grep_search: "file_search",
  file_search: "file_search",

  webfetch: "web_search",
  websearch: "web_search",
  fetch: "web_search",
  web_fetch: "web_search",
  web_search: "web_search",
};

export function toolItemType(name: string): ToolItemType {
  const key = name.toLowerCase();
  return Object.hasOwn(TOOL_ITEM_TYPES, key) ? TOOL_ITEM_TYPES[key]! : "dynamic_tool";
}

/** Epoch ms of a journal timestamp, or null when the harness wrote none (Grok, Cursor). */
export function parseEntryTime(ts: string): number | null {
  if (ts === "") return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function shortHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

function partHead(part: TranscriptPart | undefined): string {
  if (part === undefined) return "";
  return part.kind === "tool" ? `${part.name} ${part.summary}` : part.text;
}

/**
 * The entry's key: its uuid, or for an entry with none `h_` + a short hash of
 * `role|ts|first 80 chars of its first part`, which is the same on every parse.
 */
export function entryKey(entry: TranscriptEntry): string {
  if (entry.uuid !== "") return entry.uuid;
  return `h_${shortHash(`${entry.role}|${entry.ts}|${partHead(entry.parts[0]).slice(0, 80)}`)}`;
}

export function itemIdFor(entry: TranscriptEntry, partIndex: number): string {
  return `${entryKey(entry)}:${partIndex}`;
}

/** Every item id an entry can produce (one per part, mapped or not). */
export function entryItemIds(entry: TranscriptEntry): string[] {
  return entry.parts.map((_, i) => itemIdFor(entry, i));
}

/** A user entry that says something (it opens a run in a backfill). */
export function isUserSpeech(entry: TranscriptEntry): boolean {
  return entry.role === "user" && entry.parts.some((p) => p.kind === "text");
}

export interface ItemContext {
  threadId: string;
  runId: string | null;
  /** Whether that run is still open: a tool call with no result is then `running`, else `completed`. */
  runOpen: boolean;
  /** `createdAt` for an entry with no timestamp (when the ingest first saw it). */
  createdAt: number;
  updatedAt: number;
}

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;

/** `failed` on an error result; `completed` with a result or when the harness records none; else by run. */
export function toolStatus(part: ToolPart, runOpen: boolean): TurnItemStatus {
  if (part.result?.isError) return "failed";
  if (part.result !== undefined || part.unrecorded) return "completed";
  return runOpen ? "running" : "completed";
}

const MAX_SEARCH_RESULTS = 200;

/** Grep/Glob output lines as T3 search results: `path:line:preview`, or a bare path. */
export function searchResults(text: string): FileSearchResult[] {
  const results: FileSearchResult[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    results.push(m ? { fileName: m[1]!, line: Number(m[2]), preview: m[3]! } : { fileName: line });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  return results;
}

/**
 * The turn items for one entry, in part order. A pending Grok `ask` is not an item (T04 turns it into
 * a question card); once it has a result it maps like any other tool, under the same id.
 */
export function entryItems(entry: TranscriptEntry, ctx: ItemContext): TurnItemDraft[] {
  const key = entryKey(entry);
  const createdAt = parseEntryTime(entry.ts) ?? ctx.createdAt;
  const items: TurnItemDraft[] = [];
  entry.parts.forEach((part, index) => {
    const truncated = part.kind === "tool" ? part.result?.truncated === true : part.truncated === true;
    const base = {
      id: `${key}:${index}`,
      threadId: ctx.threadId,
      runId: ctx.runId,
      title: null,
      startedAt: null,
      completedAt: null,
      createdAt,
      updatedAt: ctx.updatedAt,
      ...(truncated ? { truncated: true } : {}),
    };
    if (part.kind === "thinking") {
      items.push({ ...base, status: "completed", type: "reasoning", text: part.text, streaming: false });
      return;
    }
    if (part.kind === "text") {
      if (entry.role === "user") {
        items.push({ ...base, status: "completed", type: "user_message", messageId: key, text: part.text, attachments: [] });
      } else if (entry.role === "assistant") {
        items.push({ ...base, status: "completed", type: "assistant_message", messageId: key, text: part.text, streaming: false });
      } else {
        items.push({ ...base, status: "completed", type: "system_notice", message: part.text });
      }
      return;
    }
    if (part.ask !== undefined && part.result === undefined) return;
    const tool = {
      ...base,
      status: toolStatus(part, ctx.runOpen),
      title: part.name,
      startedAt: createdAt,
    };
    const result = part.result;
    switch (toolItemType(part.name)) {
      case "command_execution":
        items.push({
          ...tool,
          type: "command_execution",
          input: part.summary,
          ...(result ? { output: result.text } : {}),
          ...(result?.isError ? { outputIndicatesFailure: true } : {}),
        });
        return;
      case "file_change":
        items.push({ ...tool, type: "file_change", fileName: part.summary });
        return;
      case "file_search":
        items.push({
          ...tool,
          type: "file_search",
          ...(part.summary !== "" ? { pattern: part.summary } : {}),
          ...(result && !result.isError ? { results: searchResults(result.text) } : {}),
        });
        return;
      case "web_search": {
        const url = /^https?:\/\//i.test(part.summary) ? part.summary : undefined;
        items.push({
          ...tool,
          type: "web_search",
          ...(part.summary !== "" ? { patterns: [part.summary] } : {}),
          ...(result ? { results: [{ ...(url ? { url } : {}), snippet: result.text }] } : {}),
        });
        return;
      }
      default:
        items.push({
          ...tool,
          type: "dynamic_tool",
          toolName: part.name,
          input: part.summary,
          ...(result ? { output: result.text } : {}),
        });
    }
  });
  return items;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Same item body, ignoring the store's `ordinal` and the `updatedAt` stamp. */
export function sameItemBody(a: TurnItem | TurnItemDraft, b: TurnItem | TurnItemDraft): boolean {
  const strip = ({ ordinal: _o, updatedAt: _u, ...rest }: TurnItemDraft) => JSON.stringify(stable(rest));
  return strip(a as TurnItemDraft) === strip(b as TurnItemDraft);
}
