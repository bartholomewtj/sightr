import type { AgentSessionRef, TranscriptSource } from "../journal/types.ts";

// An in-memory journal source for the incremental-read and journal-ingest tests: logs live in a map
// keyed by path, an `id` ref `x` names `/fake/x.jsonl`, and every call is counted.

const utf8 = new TextEncoder();

export interface MemoryLogs {
  source: TranscriptSource;
  calls: { resolve: number; stat: number; readRange: { path: string; start: number; end: number }[] };
  /** Replace a session's log (a new mtime, like a real write). */
  write(session: string, text: string): void;
  append(session: string, text: string): void;
  text(session: string): string;
  pathOf(session: string): string;
}

export function memoryLogs(): MemoryLogs {
  const files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
  let clock = 1_000;
  const calls: MemoryLogs["calls"] = { resolve: 0, stat: 0, readRange: [] };
  const pathOf = (session: string) => `/fake/${session}.jsonl`;
  const put = (session: string, text: string) => files.set(pathOf(session), { bytes: utf8.encode(text), mtimeMs: ++clock });
  const source: TranscriptSource = {
    async resolve(ref: AgentSessionRef) {
      calls.resolve++;
      const path = ref.kind === "id" ? pathOf(ref.value) : null;
      return path !== null && files.has(path) ? path : null;
    },
    async stat(path) {
      calls.stat++;
      const f = files.get(path);
      return f ? { size: f.bytes.length, mtimeMs: f.mtimeMs } : null;
    },
    async load(path) {
      const f = files.get(path)!;
      return { text: new TextDecoder().decode(f.bytes), complete: true, size: f.bytes.length, mtimeMs: f.mtimeMs };
    },
    async readRange(path, start, end) {
      calls.readRange.push({ path, start, end });
      return files.get(path)!.bytes.slice(start, end);
    },
  };
  return {
    source,
    calls,
    write: put,
    append: (session, text) => put(session, (files.has(pathOf(session)) ? new TextDecoder().decode(files.get(pathOf(session))!.bytes) : "") + text),
    text: (session) => new TextDecoder().decode(files.get(pathOf(session))?.bytes ?? new Uint8Array()),
    pathOf,
  };
}

// Claude Code rows (the real grammar `parseClaudeTranscript` reads), one JSON line each, newline-ended.

const iso = (ms: number) => new Date(ms).toISOString();

export const claudeRow = {
  user: (uuid: string, text: string, ms: number) =>
    JSON.stringify({ type: "user", uuid, timestamp: iso(ms), message: { role: "user", content: text } }) + "\n",
  assistant: (uuid: string, text: string, ms: number) =>
    JSON.stringify({ type: "assistant", uuid, timestamp: iso(ms), message: { role: "assistant", content: [{ type: "text", text }] } }) +
    "\n",
  toolUse: (uuid: string, id: string, name: string, input: unknown, ms: number) =>
    JSON.stringify({
      type: "assistant",
      uuid,
      timestamp: iso(ms),
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    }) + "\n",
  toolResult: (uuid: string, id: string, text: string, ms: number, isError = false) =>
    JSON.stringify({
      type: "user",
      uuid,
      timestamp: iso(ms),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] },
    }) + "\n",
};
