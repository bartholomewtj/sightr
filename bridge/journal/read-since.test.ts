import { describe, expect, test } from "bun:test";

import { claudeRow, memoryLogs } from "../test/journal-fakes.ts";
import { parseClaudeTranscript } from "./claude.ts";
import { OVERLAP_BYTES, type ReadSinceResult, type SavedRead, TranscriptStore } from "./store.ts";
import type { JournalAdapter } from "./types.ts";

// TranscriptStore.readSince: the incremental read the v2 journal ingest drives.

const REF = { kind: "id", value: "s1" } as const;
const bytes = (text: string) => new TextEncoder().encode(text).length;

function setup() {
  const logs = memoryLogs();
  const adapter: JournalAdapter = { agent: "claude", source: logs.source, parse: (t) => parseClaudeTranscript(t) };
  return { logs, adapter, store: new TranscriptStore() };
}

function saved(r: ReadSinceResult): SavedRead {
  if (r.kind !== "read") throw new Error(`expected a read, got ${r.kind}`);
  return { path: r.path, offset: r.nextOffset, size: r.size, mtimeMs: r.mtimeMs };
}

/** Lines of padding the parser skips (no message), so a log can be made big without entries. */
const padding = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: "mode", i, pad: "x".repeat(200) }) + "\n").join("");

describe("readSince", () => {
  test("an unchanged stat reads nothing", async () => {
    const { logs, adapter, store } = setup();
    logs.write("s1", claudeRow.user("u1", "hello", 1_000));
    const first = await store.readSince(adapter, REF, null);
    expect(first.kind).toBe("read");
    const reads = logs.calls.readRange.length;
    const second = await store.readSince(adapter, REF, saved(first));
    expect(second).toEqual({ kind: "unchanged", path: logs.pathOf("s1") });
    expect(logs.calls.readRange.length).toBe(reads);
  });

  test("a first read starts at byte 0 and flags reset", async () => {
    const { logs, adapter, store } = setup();
    logs.write("s1", claudeRow.user("u1", "héllo", 1_000) + claudeRow.assistant("a1", "hi", 2_000));
    const r = await store.readSince(adapter, REF, null);
    if (r.kind !== "read") throw new Error("expected a read");
    expect(r.reset).toBe(true);
    expect(r.fromStart).toBe(true);
    expect(r.entries.map((e) => e.uuid)).toEqual(["u1", "a1"]);
    expect(r.nextOffset).toBe(bytes(logs.text("s1")));
  });

  test("an append reads from offset minus the overlap, from the next line start", async () => {
    const { logs, adapter, store } = setup();
    logs.write("s1", padding(1_600) + claudeRow.user("u1", "old", 1_000));
    const first = await store.readSince(adapter, REF, null);
    const at = saved(first);
    expect(at.offset).toBeGreaterThan(OVERLAP_BYTES);
    logs.append("s1", claudeRow.assistant("a1", "new", 2_000));
    const r = await store.readSince(adapter, REF, at);
    if (r.kind !== "read") throw new Error("expected a read");
    expect(logs.calls.readRange.at(-1)!.start).toBe(at.offset - OVERLAP_BYTES);
    expect(r.reset).toBe(false);
    // The overlap re-reads u1; a2 is new. The ingest upserts by id, so u1 again changes nothing.
    expect(r.entries.map((e) => e.uuid)).toEqual(["u1", "a1"]);
    expect(r.nextOffset).toBe(bytes(logs.text("s1")));
  });

  test("a file shorter than the saved offset is a new file", async () => {
    const { logs, adapter, store } = setup();
    logs.write("s1", claudeRow.user("u1", "one", 1_000) + claudeRow.user("u2", "two", 2_000));
    const at = saved(await store.readSince(adapter, REF, null));
    logs.write("s1", claudeRow.user("u9", "x", 3_000));
    const r = await store.readSince(adapter, REF, at);
    if (r.kind !== "read") throw new Error("expected a read");
    expect(r.reset).toBe(true);
    expect(r.entries.map((e) => e.uuid)).toEqual(["u9"]);
  });

  test("another path is a new file", async () => {
    const { logs, adapter, store } = setup();
    logs.write("s1", claudeRow.user("u1", "one", 1_000));
    const at = saved(await store.readSince(adapter, REF, null));
    const r = await store.readSince(adapter, REF, { ...at, path: "/fake/elsewhere.jsonl" });
    if (r.kind !== "read") throw new Error("expected a read");
    expect(r.reset).toBe(true);
    expect(r.entries.map((e) => e.uuid)).toEqual(["u1"]);
  });

  test("a result in a later chunk attaches to its call within the overlap", async () => {
    const { logs, adapter, store } = setup();
    logs.write("s1", claudeRow.user("u1", "run it", 1_000) + claudeRow.toolUse("a1", "toolu_1", "Bash", { command: "ls" }, 2_000));
    const first = await store.readSince(adapter, REF, null);
    if (first.kind !== "read") throw new Error("expected a read");
    expect(first.entries[1]!.parts[0]).toMatchObject({ kind: "tool", name: "Bash" });
    expect(first.entries[1]!.parts[0]).not.toHaveProperty("result");
    logs.append("s1", claudeRow.toolResult("r1", "toolu_1", "a.txt", 3_000));
    const r = await store.readSince(adapter, REF, saved(first));
    if (r.kind !== "read") throw new Error("expected a read");
    const call = r.entries.find((e) => e.uuid === "a1")!;
    expect(call.parts[0]).toMatchObject({ kind: "tool", name: "Bash", result: { text: "a.txt" } });
    // No orphan "result" entry: the result found its call.
    expect(r.entries.map((e) => e.uuid)).toEqual(["u1", "a1"]);
  });

  test("a partial last line waits for the rest", async () => {
    const { logs, adapter, store } = setup();
    logs.write("s1", claudeRow.user("u1", "one", 1_000));
    const at = saved(await store.readSince(adapter, REF, null));
    const line = claudeRow.assistant("a1", "ünïcode", 2_000);
    const cut = line.indexOf("ünï") + 1;
    logs.append("s1", line.slice(0, cut));
    const partial = await store.readSince(adapter, REF, at);
    if (partial.kind !== "read") throw new Error("expected a read");
    expect(partial.entries.map((e) => e.uuid)).toEqual(["u1"]);
    expect(partial.nextOffset).toBe(at.offset);
    logs.append("s1", line.slice(cut));
    const done = await store.readSince(adapter, REF, saved(partial));
    if (done.kind !== "read") throw new Error("expected a read");
    expect(done.entries.map((e) => e.uuid)).toEqual(["u1", "a1"]);
    expect(done.entries[1]!.parts[0]).toEqual({ kind: "text", text: "ünïcode" });
    expect(done.nextOffset).toBe(bytes(logs.text("s1")));
  });

  test("a ref with no log is missing", async () => {
    const { adapter, store } = setup();
    expect(await store.readSince(adapter, { kind: "id", value: "nope" }, null)).toEqual({ kind: "missing" });
  });
});
