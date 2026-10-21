import type { ChatAttachment, FileSearchResult, TurnItem, TurnItemStatus } from "../../shared/v2/contracts.ts";
import type { TranscriptImage } from "../../shared/wire.ts";
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

export function shortHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

// ── Attachments ──────────────────────────────────────────────────────────────────────────────────
//
// An item's images travel as T3 `ChatAttachment`s whose `id` says where the bytes are; the v2
// attachment route (threads/attachments.ts) reads them back. Nothing here holds image bytes.

/** A log's tag in a journal attachment id: which file (of the thread's log and its siblings) holds the row. */
export const logTag = (path: string): string => shortHash(path);

/** `j_<log tag>_<line offset>_<ordinal>_<row tag>`: an image inside a harness log row. */
const JOURNAL_ATTACHMENT_ID = /^j_([0-9a-z]{1,8})_(\d{1,15})_(\d{1,4})_([0-9a-z]{1,8})$/;

export function journalAttachmentId(tag: string, image: TranscriptImage & { at: number }): string {
  return `j_${tag}_${image.at}_${image.n}_${shortHash(image.row)}`;
}

export function parseJournalAttachmentId(id: string): { tag: string; at: number; n: number; rowTag: string } | null {
  const m = JOURNAL_ATTACHMENT_ID.exec(id);
  if (!m) return null;
  return { tag: m[1]!, at: Number(m[2]), n: Number(m[3]), rowTag: m[4]! };
}

/**
 * The name the bridge gives a phone upload (pane-write-routes.ts `uploadPane`):
 * `<pane>-<base36 time>-<8 hex>.<ext>`. Anything else is not an upload.
 */
export const UPLOAD_NAME = /^[A-Za-z0-9_-]{1,128}-[0-9a-z]{1,13}-[0-9a-f]{8}\.([a-z0-9]{1,10})$/;
const UPLOAD_IMAGE_EXTS: ReadonlySet<string> = new Set(["png", "jpg", "gif", "webp"]);
const UPLOAD_MIME: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** An upload's file name when `path` is a file in an `uploads` directory with the bridge's naming, else null. */
export function uploadNameOf(path: string): string | null {
  const segments = path.split(/[\\/]/);
  const name = segments.pop() ?? "";
  if (segments.pop()?.toLowerCase() !== "uploads") return null;
  return UPLOAD_NAME.test(name) ? name : null;
}

/** The attachment for an uploaded file's path (`u_<name>`): an image chip for an image, a file chip otherwise. */
export function uploadAttachment(path: string): ChatAttachment | null {
  const name = uploadNameOf(path);
  if (name === null) return null;
  const ext = UPLOAD_NAME.exec(name)![1]!;
  const image = UPLOAD_IMAGE_EXTS.has(ext);
  return { type: image ? "image" : "file", id: `u_${name}`, name, path, ...(image ? { mimeType: UPLOAD_MIME[ext]! } : {}) };
}

/**
 * A user message as the agent got it, split back into words and the uploads Sightr appended to them
 * (`dispatch.ts messageText`: the text, then each upload's path, space-joined). A path with a space
 * in it is not recognised and stays in the text.
 */
export function splitUploads(text: string): { text: string; attachments: ChatAttachment[] } {
  const attachments: ChatAttachment[] = [];
  const rest = text.replace(/(^|\s)(\S+[\\/]uploads[\\/][^\s\\/]+)(?=\s|$)/gi, (whole, lead: string, path: string) => {
    const attachment = uploadAttachment(path);
    if (attachment === null) return whole;
    attachments.push(attachment);
    return lead;
  });
  return attachments.length === 0 ? { text, attachments } : { text: rest.replace(/[ \t]+$/gm, "").trimEnd(), attachments };
}

/** A part's logged images as attachments, when the read knew its log (`logTag`) and each image's offset. */
export function imageAttachments(images: readonly TranscriptImage[] | undefined, tag: string | undefined): ChatAttachment[] {
  if (!images || tag === undefined) return [];
  return images.flatMap((image) =>
    image.at === undefined
      ? []
      : [
          {
            type: "image" as const,
            id: journalAttachmentId(tag, image as TranscriptImage & { at: number }),
            name: image.name,
            path: "",
            ...(image.mimeType ? { mimeType: image.mimeType } : {}),
            sizeBytes: image.sizeBytes,
          },
        ],
  );
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
  /** The thread's harness, for a `subagent` item's `driver` (T3's provider kind). */
  harness?: string;
  /** {@link logTag} of the log these entries were read from; without it logged images get no attachment. */
  logTag?: string;
}

/** A subagent's own status word (Claude `Agent`, Pi `subagent`) as the item status, when it overrides the call's. */
function subagentItemStatus(agentStatus: string | undefined, toolStatus: TurnItemStatus): TurnItemStatus {
  switch (agentStatus?.toLowerCase()) {
    case "error":
    case "failed":
      return "failed";
    // Pi reports a subagent that finished its turn as `stopped`; only these mean it was cut short.
    case "cancelled":
    case "killed":
    case "aborted":
      return toolStatus === "running" ? "running" : "interrupted";
    default:
      return toolStatus;
  }
}

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;

/** `failed` on an error result; `completed` with a result or when the harness records none; else by run. */
export function toolStatus(part: ToolPart, runOpen: boolean): TurnItemStatus {
  if (part.result?.isError) return "failed";
  if (part.result !== undefined || part.unrecorded) return "completed";
  return runOpen ? "running" : "completed";
}

const MAX_SEARCH_RESULTS = 200;

/**
 * Lines a search tool prints about its results rather than as one: Claude's Grep/Glob headers
 * ("Found 3 files", "No files found", "Found 12 total occurrences across 4 files.") and truncation note.
 */
const SEARCH_CHROME_RE =
  /^(?:Found \d+ (?:files?|lines?|matches?|total occurrences?)\b.*|No (?:files|matches) found\.?|\(Results are truncated.*\)|\[Showing results with pagination.*\])$/i;

/** Grep/Glob output lines as T3 search results: `path:line:preview`, or a bare path. */
export function searchResults(text: string): FileSearchResult[] {
  const results: FileSearchResult[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || SEARCH_CHROME_RE.test(line)) continue;
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
    const truncated =
      part.kind === "tool"
        ? part.result?.truncated === true || part.inputTruncated === true || part.detail?.truncated === true
        : part.truncated === true;
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
      if (part.error !== undefined) {
        // A provider failure the harness logged (T3's `error` item; web2 draws the usage-limit row).
        items.push({ ...base, status: "failed", type: "error", failure: part.error });
      } else if (part.notice === "interrupted") {
        items.push({ ...base, status: "completed", type: "run_interrupt_result", message: part.text });
      } else if (entry.role === "summary") {
        // The summary Claude writes when it compacts a session: a short divider, the text behind it.
        items.push({ ...base, status: "completed", type: "compaction", driver: ctx.harness ?? null, summary: part.text });
      } else if (entry.role === "user") {
        const words = splitUploads(part.text);
        const attachments = [...imageAttachments(part.images, ctx.logTag), ...words.attachments];
        items.push({ ...base, status: "completed", type: "user_message", messageId: key, text: words.text, attachments });
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
    const detail = part.detail;
    const errorText = result?.isError && result.text.trim() !== "" ? { errorText: result.text } : {};
    // Structured kinds first: what the call carried decides the T3 item, whatever the tool is named.
    if (detail?.kind === "todo" && !result?.isError) {
      items.push({ ...tool, type: "todo_list", planId: `${key}:${index}`, steps: detail.steps });
      return;
    }
    if (detail?.kind === "plan") {
      items.push({ ...tool, type: "proposed_plan", planId: `${key}:${index}`, markdown: detail.markdown, streaming: false });
      return;
    }
    if (detail?.kind === "subagent") {
      items.push({
        ...tool,
        status: subagentItemStatus(detail.status, tool.status),
        title: detail.title ?? (part.summary || part.name),
        type: "subagent",
        subagentId: detail.agentId ?? `${key}:${index}`,
        origin: "provider_native",
        driver: ctx.harness ?? "",
        providerInstanceId: ctx.harness ?? "",
        childThreadId: null,
        prompt: detail.prompt ?? "",
        result: result ? result.text : null,
        ...(detail.model ? { model: detail.model } : {}),
        ...(detail.status ? { agentStatus: detail.status } : {}),
        ...(detail.progress ? { progress: detail.progress } : {}),
        ...(detail.transcriptPath ? { transcriptPath: detail.transcriptPath } : {}),
        // Claude keeps every agent's log beside the session's, named by its id; Pi names the file in a check's details.
        // A Pi launch has none until a check, but its log exists from the start and the bridge finds it by the brief.
        ...(detail.transcriptPath || (ctx.harness === "claude" && detail.agentId) || (ctx.harness === "pi" && detail.agentId && detail.prompt)
          ? { transcript: true as const }
          : {}),
        ...(detail.durationMs !== undefined ? { durationMs: detail.durationMs } : {}),
        ...(detail.tokens ? { tokens: detail.tokens } : {}),
        ...(detail.toolUses !== undefined ? { toolUses: detail.toolUses } : {}),
      });
      return;
    }
    switch (toolItemType(part.name)) {
      case "command_execution":
        items.push({
          ...tool,
          type: "command_execution",
          input: part.summary,
          ...(result ? { output: result.text } : {}),
          ...(result?.isError ? { outputIndicatesFailure: true } : {}),
          ...(result?.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        });
        return;
      case "file_change": {
        const diff = detail?.kind === "diff" ? detail : undefined;
        items.push({
          ...tool,
          type: "file_change",
          fileName: diff?.fileName || part.summary,
          ...(diff?.additions !== undefined ? { additions: diff.additions } : {}),
          ...(diff?.deletions !== undefined ? { deletions: diff.deletions } : {}),
          ...(diff?.diff ? { diffStr: diff.diff } : {}),
          ...(diff?.oldStr ? { oldStr: diff.oldStr } : {}),
          ...(diff?.newStr ? { newStr: diff.newStr } : {}),
          ...errorText,
        });
        return;
      }
      case "file_search":
        items.push({
          ...tool,
          type: "file_search",
          ...(part.summary !== "" ? { pattern: part.summary } : {}),
          ...(result && !result.isError ? { results: searchResults(result.text) } : {}),
          ...errorText,
        });
        return;
      case "web_search": {
        const url = /^https?:\/\//i.test(part.summary) ? part.summary : undefined;
        items.push({
          ...tool,
          type: "web_search",
          ...(part.summary !== "" ? { patterns: [part.summary] } : {}),
          ...(result && !result.isError ? { results: [{ ...(url ? { url } : {}), snippet: result.text }] } : {}),
          ...errorText,
        });
        return;
      }
      default: {
        const attachments = imageAttachments(part.images, ctx.logTag);
        items.push({
          ...tool,
          type: "dynamic_tool",
          toolName: part.name,
          input: part.summary,
          ...(result ? { output: result.text } : {}),
          ...(part.input !== undefined ? { rawInput: part.input } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        });
      }
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
