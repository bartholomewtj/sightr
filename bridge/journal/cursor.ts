// Cursor CLI's journal adapter (history from agent-transcripts; live TUI is harness/cursor).
//
// SHAPE OF THE SOURCE (verified against on-disk agent-transcripts, 2026-09-12):
//   ~/.cursor/projects/<workspace-slug>/agent-transcripts/<uuid>/<uuid>.jsonl
//   {"role":"user","message":{"content":[{"type":"text","text":"<timestamp>…</timestamp>\n<user_query>…</user_query>"}]}}
//   {"role":"assistant","message":{"content":[{"type":"text","text":"…"},{"type":"tool_use","name":"Shell","input":{…}}]}}
//
// Herdr's cursor integration reports `agent_session.kind: "id"` with the chat UUID. Do NOT read
// `~/.cursor/chats/.../store.db` — those blobs are often encrypted (`blobEncryptionKey` in meta).
//
// Tool results are not persisted in this JSONL (only `tool_use`); tools render without a result body.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { containedRealpath, exists, loadTail, rootList, statFile } from "./files.ts";
import { clamp, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

/** Cursor chat ids are uuids — validated before any path work. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCursorSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** Inner text of the first `<tag>…</tag>`, trimmed; null when the tag isn't present. */
function inner(tag: string, text: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? (m[1] ?? "").trim() : null;
}

/**
 * Human-facing text from a Cursor user turn.
 *
 * Operator prompts arrive wrapped in `<user_query>`; timestamps and other envelopes are noise for
 * the phone chat view. Falls back to the raw string when no query wrapper is present.
 */
export function displayUserText(raw: string): string {
  const query = inner("user_query", raw);
  if (query !== null && query !== "") return query;
  const stripped = raw
    .replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, "")
    .replace(/<\/?user_query>/g, "")
    .trim();
  return stripped === "" ? raw.trim() : stripped;
}

interface RawRow {
  role?: unknown;
  message?: { content?: unknown } | unknown;
  id?: unknown;
}

/**
 * Parse a Cursor agent-transcripts JSONL into oldest-first turns.
 *
 * PURE — no fs, no clock. Unparseable lines are skipped (live append / mid-line tail reads).
 */
export function parseCursorTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let seq = 0;

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: RawRow;
    try {
      row = JSON.parse(line) as RawRow;
    } catch {
      continue;
    }

    const role = row.role;
    if (role !== "user" && role !== "assistant") continue;

    const message = row.message;
    if (message === null || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    const uuid =
      typeof row.id === "string" && row.id !== ""
        ? row.id
        : `cursor-${seq}`;
    seq += 1;
    const parts: TranscriptPart[] = [];

    if (typeof content === "string") {
      const shown = role === "user" ? displayUserText(content) : stripAnsi(content);
      if (shown.trim() !== "") parts.push({ kind: "text", ...clamp(shown, MAX_TEXT_CHARS) });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          const raw = b.text;
          const shown = role === "user" ? displayUserText(raw) : stripAnsi(raw);
          if (shown.trim() !== "") parts.push({ kind: "text", ...clamp(shown, MAX_TEXT_CHARS) });
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
          if (b.thinking.trim() !== "")
            parts.push({ kind: "thinking", ...clamp(stripAnsi(b.thinking), MAX_TEXT_CHARS) });
        } else if (b.type === "reasoning" && typeof b.text === "string") {
          // Cursor sometimes labels reasoning as `reasoning` with empty text — skip empties.
          if (b.text.trim() !== "")
            parts.push({ kind: "thinking", ...clamp(stripAnsi(b.text), MAX_TEXT_CHARS) });
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          parts.push({
            kind: "tool",
            name: b.name,
            summary: summarizeToolInput(b.input),
          });
        }
      }
    }

    if (parts.length === 0) continue;
    entries.push({
      uuid,
      ts: "",
      role: role === "assistant" ? "assistant" : "user",
      parts,
    });
  }

  return entries;
}

/**
 * Real filesystem source under Cursor's `projects` tree.
 *
 * Layout: `<root>/<workspace-slug>/agent-transcripts/<uuid>/<uuid>.jsonl`. Session uuids are
 * globally unique, so scanning project dirs (same idea as Claude) is correct and cheap.
 */
export class CursorTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, string>();
  private readonly roots: string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isCursorSessionId(ref.value)) return null;
    const sessionId = ref.value;
    const cached = this.pathCache.get(sessionId);
    if (cached !== undefined) {
      if (await exists(cached)) return cached;
      this.pathCache.delete(sessionId);
    }

    const file = `${sessionId}.jsonl`;
    for (const root of this.roots) {
      let projects: string[];
      try {
        projects = await readdir(root);
      } catch {
        continue;
      }
      for (const project of projects) {
        const candidate = join(root, project, "agent-transcripts", sessionId, file);
        if (!(await exists(candidate))) continue;
        const real = await containedRealpath(candidate, root);
        if (real === null) break;
        this.pathCache.set(sessionId, real);
        return real;
      }
    }
    return null;
  }

  stat = statFile;

  load = loadTail;
}

/** Cursor's journal adapter. `agent` matches Herdr's `agent` string (`cursor`). */
export function cursorJournal(roots: string | readonly string[]): JournalAdapter {
  return {
    agent: "cursor",
    source: new CursorTranscriptSource(roots),
    parse: parseCursorTranscript,
  };
}
