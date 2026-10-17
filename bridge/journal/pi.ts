// pi's journal adapter.
//
// SHAPE OF THE SOURCE (verified against on-disk sessions, 2026-07-29):
//   ~/.pi/agent/sessions/--<mangled-cwd>--/<ISO-ts>_<session-uuid>.jsonl
//   {"type":"session","version":3,"id":"<uuid>","timestamp":"…","cwd":"…"}      ← header, first row
//   {"type":"message","id":"…","parentId":"…","timestamp":"…","message":{ … }}
//   {"type":"model_change" | "thinking_level_change", …}                         ← bookkeeping
// Every row carries its OWN `id`, so there is nothing to synthesise for paging.
//
// `message.role` is one of `user` | `assistant` | `toolResult`. The first two carry a `content` list
// of `text` / `thinking` / `toolCall` blocks; a `toolResult` row is its own row (not a block inside a
// user turn, the way Claude does it) and links back by `toolCallId`. pi's `thinking` blocks carry
// REAL text — usually a short bolded title — so the thinking branch renders here.
//
// HOW HERDR NAMES THE SESSION — the one that's different. pi's integration reports
// `agent_session_path` in preference to `agent_session_id` (herdr integration `pi`, version 6:
// `withSessionRef` returns the path whenever `sessionManager.getSessionFile()` gave one). So a pi
// pane arrives as a kind-`path` ref: an ABSOLUTE PATH chosen by a process we don't control. It is
// treated as hostile input and confined to pi's own sessions root like everything else — see
// journal/files.ts. The id fallback is supported too, since the hook uses it when no file is open yet.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  containedRealpath,
  containedRealpathIn,
  exists,
  loadTail,
  readRange as readLogRange,
  rootList,
  statFile,
} from "./files.ts";
import type { TranscriptToolDetail, TranscriptUsage } from "../../shared/wire.ts";
import {
  capInput,
  diffDetail,
  diffForNewFile,
  diffFromReplacements,
  mergeSubagent,
  providerFailure,
  subagentDetail,
  todoDetail,
  todoStepStatus,
} from "./structured.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Pi's subagent tools: `subagent` starts one, `get_subagent_result` reads its state. */
const SUBAGENT_TOOLS = new Set(["subagent", "get_subagent_result"]);

/** What a pi call's own arguments already say: an edit's diff before its result lands, a subagent's brief. */
export function piCallDetail(name: string, args: unknown): TranscriptToolDetail | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const o = args as Record<string, unknown>;
  const file = str(o.path) ?? str(o.file_path) ?? "";
  switch (name) {
    case "edit": {
      if (file === "") return undefined;
      const list = Array.isArray(o.edits) ? o.edits : [{ oldText: o.oldText, newText: o.newText }];
      const edits = list.flatMap((e) =>
        e && typeof e === "object" && typeof (e as Record<string, unknown>).oldText === "string" &&
        typeof (e as Record<string, unknown>).newText === "string"
          ? [{ oldText: (e as { oldText: string }).oldText, newText: (e as { newText: string }).newText }]
          : [],
      );
      const diff = diffFromReplacements(file, edits);
      return diff === null ? undefined : diffDetail(file, diff);
    }
    case "write":
      return file === "" || typeof o.content !== "string" ? undefined : diffDetail(file, diffForNewFile(file, o.content));
    case "subagent":
      return subagentDetail({ title: o.description, prompt: o.prompt, model: o.model });
    case "get_subagent_result":
      return subagentDetail({ agentId: o.agent_id });
    default:
      return undefined;
  }
}

/** Refine a call's detail from its toolResult's `details` (edit's patch, todo's list, subagent facts). */
export function applyPiDetails(part: ToolPart, details: unknown): void {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return;
  const d = details as Record<string, unknown>;
  if (part.name === "edit") {
    const file = part.detail?.kind === "diff" ? part.detail.fileName : (str((part.input as { path?: unknown } | undefined)?.path) ?? part.summary);
    // `patch` is a unified diff; `diff` is pi's numbered display form, kept only when there is no patch.
    const patch = str(d.patch);
    if (patch && patch.trim() !== "") part.detail = diffDetail(file, patch);
    return;
  }
  if (part.name === "todo" && Array.isArray(d.tasks)) {
    const steps = d.tasks.flatMap((t) => {
      if (!t || typeof t !== "object") return [];
      const o = t as Record<string, unknown>;
      const status = todoStepStatus(o.status);
      const text = (str(o.subject) ?? str(o.content) ?? "").trim();
      if (status === null || text === "") return [];
      return [{ id: String(o.id ?? text), text, status }];
    });
    part.detail = todoDetail(steps);
    return;
  }
  if (SUBAGENT_TOOLS.has(part.name)) {
    const seconds = /^([\d.]+)s/.exec(str(d.duration) ?? "");
    part.detail = mergeSubagent(
      part.detail,
      subagentDetail({
        agentId: d.agentId,
        title: d.description ?? d.displayName,
        status: d.status,
        model: d.modelName,
        durationMs: typeof d.durationMs === "number" && d.durationMs > 0 ? d.durationMs : seconds ? Number(seconds[1]) * 1000 : undefined,
        tokens: d.tokens,
        toolUses: d.toolUses,
      }),
    );
  }
}

/** A pi assistant row's `usage` as context use; null when it reports nothing. */
export function piUsage(usage: unknown): TranscriptUsage | null {
  if (usage === null || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const input = n(u.input);
  const cacheRead = n(u.cacheRead);
  const cached = cacheRead + n(u.cacheWrite);
  const output = n(u.output);
  const used = input + cached + output;
  if (used === 0) return null;
  const cost = n((u.cost as { total?: unknown } | undefined)?.total);
  return {
    usedTokens: used,
    inputTokens: input + cached,
    cachedInputTokens: cacheRead,
    outputTokens: output,
    ...(cost > 0 ? { cost } : {}),
  };
}

/** pi's session ids are uuids (v4 and v7 both observed) — validated before any path work. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPiSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** Flatten a pi content list into text, keeping only `text` blocks. */
function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

interface PiRow {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: unknown;
}

/**
 * Parse a pi session log into oldest-first turns. PURE — no fs, no clock.
 *
 * Unparseable lines are skipped: the log is appended to live, so the last line can be a partial
 * write, and a tail-read window starts mid-line by construction.
 */
export function parsePiTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  // toolCall id → the part awaiting its result, so a later `toolResult` row lands on its own call.
  const pendingTools = new Map<string, Extract<TranscriptPart, { kind: "tool" }>>();

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: PiRow;
    try {
      row = JSON.parse(line) as PiRow;
    } catch {
      continue;
    }
    // `session`, `model_change`, `thinking_level_change` are bookkeeping — nothing to render.
    if (row.type !== "message") continue;
    const message = row.message;
    if (message === null || typeof message !== "object") continue;
    const m = message as Record<string, unknown>;
    const uuid = typeof row.id === "string" ? row.id : "";
    const ts = typeof row.timestamp === "string" ? row.timestamp : "";

    if (m.role === "toolResult") {
      const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
      const target = pendingTools.get(id);
      const resultText = stripAnsi(textBlocks(m.content));
      const isError = m.isError === true;
      if (target) {
        // Mutated in place — the part already sits in an emitted entry, which is why results attach
        // without reordering anything.
        pendingTools.delete(id);
        const exit = /(?:exited with code|exit code:?)\s*(\d+)/i.exec(resultText.slice(-200));
        target.result = {
          ...clamp(resultText, MAX_RESULT_CHARS),
          ...(isError ? { isError: true } : {}),
          ...(isError && exit && target.name === "bash" ? { exitCode: Number(exit[1]) } : {}),
        };
        if (!isError) applyPiDetails(target, m.details);
      } else if (resultText.trim() !== "") {
        // Orphan result (its call fell outside a tail-read window) — kept unattached so the window
        // never silently drops output.
        entries.push({
          uuid,
          ts,
          role: "assistant",
          parts: [
            {
              kind: "tool",
              name: typeof m.toolName === "string" ? m.toolName : "result",
              summary: "",
              result: { ...clamp(resultText, MAX_RESULT_CHARS), ...(isError ? { isError: true } : {}) },
            },
          ],
        });
      }
      continue;
    }

    const role: TranscriptEntry["role"] = m.role === "assistant" ? "assistant" : "user";
    const parts: TranscriptPart[] = [];
    const content = Array.isArray(m.content) ? m.content : [];
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        if (b.text.trim() !== "")
          parts.push({ kind: "text", ...clamp(stripAnsi(b.text), MAX_TEXT_CHARS) });
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        if (b.thinking.trim() !== "")
          parts.push({ kind: "thinking", ...clamp(stripAnsi(b.thinking), MAX_TEXT_CHARS) });
      } else if (b.type === "toolCall") {
        const name = typeof b.name === "string" ? b.name : "tool";
        const detail = piCallDetail(name, b.arguments);
        const part: ToolPart = {
          kind: "tool",
          name,
          // pi passes `arguments` as a real object — no parse needed.
          summary: summarizeToolInput(b.arguments),
          ...capInput(b.arguments),
          ...(detail ? { detail } : {}),
        };
        if (typeof b.id === "string") pendingTools.set(b.id, part);
        parts.push(part);
      }
    }

    // A failed turn: pi writes `stopReason: "error"` with the provider's words in `errorMessage` and,
    // usually, no content at all. Without this part the failure would be invisible. An `aborted`
    // turn is the operator's own Stop and needs no part (the run's status says it).
    if (role === "assistant" && m.stopReason === "error") {
      const message = (str(m.errorMessage) ?? "").trim() || "The model stopped with an error.";
      const code = /\[code=([\w.-]+)\]/.exec(message)?.[1] ?? null;
      const at = typeof m.timestamp === "number" ? m.timestamp : Date.parse(ts) || 0;
      parts.push({ kind: "text", ...clamp(message, MAX_TEXT_CHARS), error: providerFailure(message, { code, at }) });
    }

    if (parts.length === 0) continue; // a row with nothing renderable
    const usage = role === "assistant" ? piUsage(m.usage) : null;
    entries.push({ uuid, ts, role, parts, ...(usage ? { usage } : {}) });
  }

  return entries;
}

/**
 * Real filesystem source rooted at pi's `sessions` directory.
 *
 * Two ref kinds, because pi's hook reports whichever it has:
 *  - `path` — the common case. Confined to the root after symlink resolution, so a path pointing
 *    anywhere else resolves to null and reads to the client as an ordinary "no log".
 *  - `id`   — the fallback. The uuid is the filename SUFFIX (`<ISO-ts>_<uuid>.jsonl`) inside a
 *    per-cwd directory, so this is a scan of the project dirs, cached after the first hit.
 */
export class PiTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, string>();

  private readonly roots: string[];

  /** One sessions directory or several (a second `PI_CODING_AGENT_DIR`), searched in order. */
  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind === "path") {
      // No shape validation is possible on a free-form path — containment IS the validation. No root
      // built this name, so every configured root is asked whether the file is its own; the first
      // that really contains it answers (files.ts header).
      if (!ref.value.endsWith(".jsonl")) return null;
      if (!(await exists(ref.value))) return null;
      return containedRealpathIn(ref.value, this.roots);
    }

    if (!isPiSessionId(ref.value)) return null;
    const sessionId = ref.value;
    const cached = this.pathCache.get(sessionId);
    if (cached !== undefined) {
      if (await exists(cached)) return cached;
      this.pathCache.delete(sessionId);
    }

    const suffix = `_${sessionId.toLowerCase()}.jsonl`;
    for (const root of this.roots) {
      const hit = await this.findUnder(root, suffix);
      if (hit === null) continue; // absent here, or present but not this root's to serve
      this.pathCache.set(sessionId, hit);
      return hit;
    }
    return null;
  }

  /** The log whose name ends in `suffix` under one sessions root, contained by that root. */
  private async findUnder(root: string, suffix: string): Promise<string | null> {
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      return null; // no sessions root at all — nothing to serve
    }
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await readdir(join(root, dir));
      } catch {
        continue;
      }
      const hit = names.find((n) => n.toLowerCase().endsWith(suffix));
      if (hit === undefined) continue;
      return containedRealpath(join(root, dir, hit), root);
    }
    return null;
  }

  stat = statFile;

  load = loadTail;

  readRange = readLogRange;
}

/** pi's journal adapter. `agent` matches the Herdr snapshot's `agent` string. */
export function piJournal(roots: string | readonly string[]): JournalAdapter {
  return {
    agent: "pi",
    source: new PiTranscriptSource(roots),
    parse: parsePiTranscript,
  };
}
