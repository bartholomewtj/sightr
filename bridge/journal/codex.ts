// Codex CLI's journal adapter (T16).
//
// SHAPE OF THE SOURCE. Derived from the Codex source (github.com/openai/codex at 4eb4a654, 16 Oct
// 2026), NOT from a live capture: Codex was not installed on the machine this was built on. The
// fixtures under ./fixtures/codex-*.jsonl follow those shapes with invented content.
//
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread uuid>.jsonl
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<thread uuid>_<rollout uuid>.jsonl   (a reverted thread)
//   …/rollout-….jsonl.zst                                                          (cold, compressed)
//
// The date directories and the filename stamp are LOCAL time (codex-rs/rollout/src/recorder.rs). Every
// line is one `RolloutLine` (codex-rs/history/src/lib.rs):
//
//   {"timestamp":"2026-10-17T03:04:05.123Z","ordinal":12,"type":"<item>","payload":{…}}
//
// `ordinal` is present only in "paginated" rollouts, where it is unique and increasing per line.
// `type` is one of session_meta, response_item, event_msg, turn_context, compacted, token_usage_record,
// world_state, retained_context, inter_agent_communication, … (rollout_payload.rs). Only response_item
// rows (codex-rs/protocol/src/models.rs `ResponseItem`) carry the conversation, and Codex persists
// every kind of them (rollout/src/policy.rs); `event_msg` rows duplicate them for the TUI and are
// ignored here. Anything unknown is skipped, never thrown.
//
// HOW HERDR NAMES THE SESSION. herdr's Codex hook reports the hook payload's `session_id` (falling back
// to CODEX_THREAD_ID) as a kind-`id` ref (herdr src/integration/assets/codex/herdr-agent-state.sh).
// That is the thread uuid the rollout filename carries, so the file is found by listing, never by
// building a path from the id.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { containedRealpath, exists, loadTail, readRange as readLogRange, rootList, statFile } from "./files.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, oneLine, stripAnsi, summarizeToolInput } from "./text.ts";
import type { AgentSessionRef, JournalAdapter, TranscriptEntry, TranscriptPart, TranscriptSource } from "./types.ts";

/** Codex thread ids are uuids (v7 in current builds, v4 in older ones), validated before any path work. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCodexSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/**
 * Text Codex sends as a user-role message that the user never typed: environment context, AGENTS.md,
 * skill bodies, hook prompts, the interrupt marker and a few legacy warnings. A user message whose
 * text starts with one of these (case-insensitive, after leading whitespace) is not a user turn.
 * Taken from codex-rs/core/src/context/contextual_user_message.rs (CONTEXTUAL_USER_FRAGMENT_MATCHERS).
 */
export const CODEX_CONTEXT_PREFIXES: readonly string[] = [
  "<environment_context>",
  "# AGENTS.md instructions",
  "<user_instructions>",
  "<skill>",
  "<hook_prompt",
  "<user_shell_command>",
  "<turn_aborted>",
  "<subagent_notification>",
  "<agent_message_board_notification>",
  "<codex_internal_context",
  "<goal_context>",
  "<recommended_plugins>",
  "Warning: apply_patch was requested via ",
  "Warning: Your account was flagged for potentially high-risk cyber activity",
  "Warning: The maximum number of unified exec processes you can keep open is",
];

export function isCodexContextText(text: string): boolean {
  const head = text.trimStart().slice(0, 96).toLowerCase();
  return CODEX_CONTEXT_PREFIXES.some((prefix) => head.startsWith(prefix.toLowerCase()));
}

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function shortHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/** `text` of every content item of the given types, in order. */
function contentTexts(content: unknown, types: readonly string[]): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const item of content) {
    if (isObj(item) && types.includes(item.type as string) && typeof item.text === "string") out.push(item.text);
  }
  return out;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish", "pwsh", "powershell", "powershell.exe", "pwsh.exe", "cmd", "cmd.exe"]);
const SHELL_FLAGS = new Set(["-c", "-lc", "-ic", "-command", "/c"]);

/** A Codex argv as the line the user would have typed: `["bash","-lc","ls -la"]` reads as `ls -la`. */
function argvLine(argv: unknown): string {
  if (!Array.isArray(argv)) return "";
  const parts = argv.filter((x): x is string => typeof x === "string");
  if (parts.length >= 3 && SHELLS.has(parts[0]!.toLowerCase().split(/[\\/]/).pop()!)) {
    const flag = parts.findIndex((p, i) => i > 0 && SHELL_FLAGS.has(p.toLowerCase()));
    if (flag > 0 && flag < parts.length - 1) return parts.slice(flag + 1).join(" ");
  }
  return parts.join(" ");
}

/** The files an apply_patch body touches (`*** Update File: path`), as one line. */
function patchFiles(patch: string): string {
  const files: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) files.push(m[1]!.trim());
  return files.join(", ");
}

/** One-line summary of a Codex tool call's arguments. */
function toolSummary(name: string, args: unknown): string {
  const lower = name.toLowerCase();
  if (typeof args === "string") {
    // A custom (freeform) tool's raw input, or arguments that were not JSON.
    if (lower === "apply_patch") return oneLine(patchFiles(args) || args);
    return oneLine(args);
  }
  if (!isObj(args)) return "";
  if (lower === "shell" || lower === "container.exec" || lower === "local_shell") {
    if (Array.isArray(args.command)) return oneLine(argvLine(args.command));
  }
  if (lower === "exec_command" && typeof args.cmd === "string") return oneLine(args.cmd);
  if (lower === "write_stdin" && typeof args.chars === "string") return oneLine(args.chars);
  if (lower === "apply_patch" && typeof args.input === "string") return oneLine(patchFiles(args.input) || args.input);
  return summarizeToolInput(args);
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** Exec-output header lines Codex puts above `Output:` (core/src/tools/mod.rs, tools/context.rs). */
const HEADER_LINE_RE =
  /^(?:Chunk ID: .*|Wall time: .*|Exit code: -?\d+|Process exited with code -?\d+|Process running with session ID .*|Original token count: .*|Total output lines: .*)$/;

/**
 * A tool output as display text plus whether it reports failure. Codex encodes the exit status in the
 * text itself (`Exit code: 1` or `Process exited with code 1` above an `Output:` line); older builds
 * wrote `{"output":"…","metadata":{"exit_code":1}}`. The header is dropped from the display text.
 */
export function readToolOutput(output: unknown): { text: string; isError: boolean } {
  let text: string;
  if (typeof output === "string") text = output;
  else if (Array.isArray(output)) text = contentTexts(output, ["input_text", "output_text", "text"]).join("\n");
  else if (isObj(output) && typeof output.content === "string") text = output.content;
  else return { text: "", isError: false };

  if (text.startsWith("{")) {
    try {
      const legacy = JSON.parse(text) as unknown;
      if (isObj(legacy) && typeof legacy.output === "string") {
        const code = isObj(legacy.metadata) ? legacy.metadata.exit_code : undefined;
        return { text: legacy.output, isError: typeof code === "number" && code !== 0 };
      }
    } catch {
      // Plain text that happens to start with a brace.
    }
  }

  const lines = text.split("\n");
  const outputAt = lines.findIndex((l) => l === "Output:");
  if (outputAt > 0 && outputAt <= 8 && lines.slice(0, outputAt).every((l) => HEADER_LINE_RE.test(l))) {
    const header = lines.slice(0, outputAt).join("\n");
    const code = /^(?:Exit code: |Process exited with code )(-?\d+)$/m.exec(header);
    return { text: lines.slice(outputAt + 1).join("\n"), isError: code !== null && Number(code[1]) !== 0 };
  }
  return { text, isError: false };
}

interface Line {
  timestamp?: unknown;
  ordinal?: unknown;
  type?: unknown;
  payload?: unknown;
}

/**
 * Parse a Codex rollout into oldest-first entries. PURE — no fs, no clock.
 *
 * One entry per response_item record, like the Claude and Pi adapters, so an entry's id never depends
 * on where a read window started. Ids: the item's own Responses API id (`msg_…`, `rs_…`, `fc_…`), else
 * the line's `ordinal`, else the call id, else a hash of timestamp, type and the first 64 characters of
 * the text; a repeat within one parse gets a `~n` suffix. A tool output attaches to the call with the
 * same call id; an output whose call fell outside the window becomes its own entry.
 */
export function parseCodexTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const pending = new Map<string, ToolPart>();
  const seen = new Map<string, number>();

  const uniq = (key: string): string => {
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? key : `${key}~${n}`;
  };

  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue; // a partial write, or the clipped head of a tail read
    }
    if (!isObj(line) || !isObj(line.payload)) continue;
    const ts = str(line.timestamp) ?? "";
    const p = line.payload;
    const ptype = str(p.type) ?? "";

    const idFor = (head: string, callId?: string): string => {
      const own = str(p.id);
      if (own && own !== "") return uniq(own);
      if (typeof line.ordinal === "number" && Number.isInteger(line.ordinal)) return uniq(`o${line.ordinal}`);
      if (callId) return uniq(`${ptype}_${callId}`);
      return uniq(`h_${shortHash(`${ts}|${ptype}|${head.slice(0, 64)}`)}`);
    };

    if (line.type === "compacted") {
      entries.push({ uuid: idFor("compacted"), ts, role: "note", parts: [{ kind: "text", text: "Context compacted" }] });
      continue;
    }
    if (line.type !== "response_item") continue;

    const pushTool = (part: ToolPart, callId: string | undefined, head: string) => {
      if (callId) pending.set(callId, part);
      entries.push({ uuid: idFor(head, callId), ts, role: "assistant", parts: [part] });
    };

    switch (ptype) {
      case "message": {
        const role = str(p.role);
        if (role === "user") {
          const texts = contentTexts(p.content, ["input_text"]).filter((t) => t.trim() !== "" && !isCodexContextText(t));
          if (texts.length === 0) break;
          entries.push({
            uuid: idFor(texts[0]!),
            ts,
            role: "user",
            parts: texts.map((t) => ({ kind: "text" as const, ...clamp(stripAnsi(t), MAX_TEXT_CHARS) })),
          });
        } else if (role === "assistant") {
          const texts = contentTexts(p.content, ["output_text"]).filter((t) => t.trim() !== "");
          if (texts.length === 0) break;
          entries.push({
            uuid: idFor(texts[0]!),
            ts,
            role: "assistant",
            parts: texts.map((t) => ({ kind: "text" as const, ...clamp(stripAnsi(t), MAX_TEXT_CHARS) })),
          });
        }
        // developer / system messages are instructions, not conversation.
        break;
      }
      case "reasoning": {
        let texts = contentTexts(p.summary, ["summary_text"]).filter((t) => t.trim() !== "");
        if (texts.length === 0) texts = contentTexts(p.content, ["reasoning_text", "text"]).filter((t) => t.trim() !== "");
        if (texts.length === 0) break; // encrypted-only or empty reasoning
        const joined = texts.join("\n\n");
        entries.push({ uuid: idFor(joined), ts, role: "assistant", parts: [{ kind: "thinking", ...clamp(stripAnsi(joined), MAX_TEXT_CHARS) }] });
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const name = str(p.name) ?? "tool";
        const callId = str(p.call_id);
        const args = ptype === "custom_tool_call" ? str(p.input) ?? "" : parseArgs(p.arguments);
        pushTool({ kind: "tool", name, summary: toolSummary(name, args) }, callId, name);
        break;
      }
      case "local_shell_call": {
        const action = isObj(p.action) ? p.action : {};
        const callId = str(p.call_id) ?? str(p.id);
        pushTool({ kind: "tool", name: "shell", summary: oneLine(argvLine(action.command)) }, callId, "local_shell");
        break;
      }
      case "tool_search_call": {
        const callId = str(p.call_id);
        pushTool({ kind: "tool", name: "tool_search", summary: summarizeToolInput(p.arguments) }, callId, "tool_search");
        break;
      }
      case "web_search_call": {
        const action = isObj(p.action) ? p.action : {};
        const queries = Array.isArray(action.queries) ? action.queries.filter((q): q is string => typeof q === "string") : [];
        const summary = oneLine(str(action.query) ?? queries[0] ?? str(action.url) ?? str(action.pattern) ?? "");
        const status = str(p.status);
        const part: ToolPart = { kind: "tool", name: "web_search", summary };
        // Codex records no output for a search: a finished one is complete with nothing to open.
        if (status === "failed") part.result = { text: "Search failed", isError: true };
        else if (status === undefined || status === "completed") part.unrecorded = true;
        pushTool(part, undefined, `web_search ${summary}`);
        break;
      }
      case "image_generation_call": {
        const part: ToolPart = { kind: "tool", name: "image_generation", summary: oneLine(str(p.revised_prompt) ?? ""), unrecorded: true };
        pushTool(part, undefined, "image_generation");
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output":
      case "tool_search_output": {
        const callId = str(p.call_id);
        const read =
          ptype === "tool_search_output"
            ? { text: `${Array.isArray(p.tools) ? p.tools.length : 0} tools`, isError: false }
            : readToolOutput(p.output);
        const result = { ...clamp(stripAnsi(read.text), MAX_RESULT_CHARS), ...(read.isError ? { isError: true } : {}) };
        const target = callId ? pending.get(callId) : undefined;
        if (target) {
          // Mutated in place: the call's entry is already emitted, so nothing reorders.
          pending.delete(callId!);
          target.result = result;
        } else if (read.text.trim() !== "" || read.isError) {
          entries.push({
            uuid: idFor(read.text, callId),
            ts,
            role: "assistant",
            parts: [{ kind: "tool", name: str(p.name) ?? "result", summary: "", result }],
          });
        }
        break;
      }
      default:
        // compaction markers, configuration updates, additional tools, agent messages and anything a
        // later Codex adds: nothing to render.
        break;
    }
  }
  return entries;
}

/** Most day directories one resolve walks per root, newest first. A deeper tree is a miss, not a stall. */
export const MAX_DAY_DIRS = 366;

const YEAR_RE = /^\d{4}$/;
const TWO_DIGITS_RE = /^\d{2}$/;
const STAMP = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

async function listDesc(dir: string, re: RegExp): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => re.test(n)).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * Real filesystem source rooted at Codex's `sessions` directory.
 *
 * Only `id` refs: herdr reports Codex's thread id, never a path, so a `path` ref is refused. The id is
 * validated, then matched against filenames the walk listed, newest day first; of several files for one
 * thread (a reverted thread keeps its id and starts a new rollout) the newest name wins. Compressed
 * `.jsonl.zst` rollouts are cold (Codex compresses after a week idle and decompresses on resume), so
 * they are not read.
 */
export class CodexTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, string>();

  private readonly roots: string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isCodexSessionId(ref.value)) return null;
    const id = ref.value.toLowerCase();
    const cached = this.pathCache.get(id);
    if (cached !== undefined) {
      if (await exists(cached)) return cached;
      this.pathCache.delete(id);
    }
    // Built from a validated uuid only: the pattern cannot match a separator or a dot-dot.
    const name = new RegExp(`^rollout-${STAMP}-${id}(?:_${UUID})?\\.jsonl$`, "i");
    for (const root of this.roots) {
      const hit = await this.findUnder(root, name);
      if (hit === null) continue;
      this.pathCache.set(id, hit);
      return hit;
    }
    return null;
  }

  private async findUnder(root: string, name: RegExp): Promise<string | null> {
    let days = 0;
    for (const year of await listDesc(root, YEAR_RE)) {
      for (const month of await listDesc(join(root, year), TWO_DIGITS_RE)) {
        for (const day of await listDesc(join(root, year, month), TWO_DIGITS_RE)) {
          if (++days > MAX_DAY_DIRS) return null;
          const dir = join(root, year, month, day);
          const hits = await listDesc(dir, name);
          if (hits.length === 0) continue;
          // Refused (it resolves outside this root) reads the same as absent.
          return containedRealpath(join(dir, hits[0]!), root);
        }
      }
    }
    return null;
  }

  stat = statFile;

  load = loadTail;

  readRange = readLogRange;
}

/** Codex CLI's journal adapter. `agent` matches the Herdr snapshot's `agent` string. */
export function codexJournal(roots: string | readonly string[]): JournalAdapter {
  return {
    agent: "codex",
    source: new CodexTranscriptSource(roots),
    parse: parseCodexTranscript,
  };
}
