import { describe, expect, test } from "bun:test";

import type { TranscriptEntry } from "../journal/types.ts";
import {
  entryItems,
  entryKey,
  type ItemContext,
  parseEntryTime,
  sameItemBody,
  searchResults,
  toolItemType,
  type ToolItemType,
} from "./turn-items.ts";

const CTX: ItemContext = { threadId: "t1", runId: "r1", runOpen: true, createdAt: 9_000, updatedAt: 9_500 };
const TS = "2026-10-16T10:00:00.000Z";
const at = Date.parse(TS);

const entry = (over: Partial<TranscriptEntry>): TranscriptEntry => ({ uuid: "e1", ts: TS, role: "assistant", parts: [], ...over });

describe("entryItems", () => {
  test("user text → user_message", () => {
    const [item] = entryItems(entry({ role: "user", parts: [{ kind: "text", text: "hi" }] }), CTX);
    expect(item).toEqual({
      id: "e1:0",
      threadId: "t1",
      runId: "r1",
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      createdAt: at,
      updatedAt: 9_500,
      type: "user_message",
      messageId: "e1",
      text: "hi",
      attachments: [],
    });
  });

  test("assistant text → assistant_message, thinking → reasoning", () => {
    const items = entryItems(
      entry({ parts: [{ kind: "thinking", text: "hmm" }, { kind: "text", text: "done" }] }),
      CTX,
    );
    expect(items.map((i) => [i.id, i.type])).toEqual([
      ["e1:0", "reasoning"],
      ["e1:1", "assistant_message"],
    ]);
    expect(items[0]).toMatchObject({ text: "hmm", streaming: false });
    expect(items[1]).toMatchObject({ text: "done", streaming: false, messageId: "e1" });
  });

  test("summary and note → system_notice", () => {
    for (const role of ["summary", "note"] as const) {
      const [item] = entryItems(entry({ role, parts: [{ kind: "text", text: "compacted" }] }), CTX);
      expect(item).toMatchObject({ type: "system_notice", message: "compacted" });
    }
  });

  test("an entry with no timestamp takes the context's first-seen time", () => {
    const [item] = entryItems(entry({ ts: "", parts: [{ kind: "text", text: "x" }] }), CTX);
    expect(item!.createdAt).toBe(9_000);
  });

  test("truncated is kept on the item", () => {
    const items = entryItems(
      entry({
        parts: [
          { kind: "text", text: "long", truncated: true },
          { kind: "tool", name: "Bash", summary: "cat big", result: { text: "…", truncated: true } },
          { kind: "text", text: "short" },
        ],
      }),
      CTX,
    );
    expect(items.map((i) => i.truncated)).toEqual([true, true, undefined]);
  });

  test("tool status: result, unrecorded, error, pending in an open and a closed run", () => {
    const tool = (part: Partial<Extract<TranscriptEntry["parts"][number], { kind: "tool" }>>, runOpen = true) =>
      entryItems(entry({ parts: [{ kind: "tool", name: "Bash", summary: "ls", ...part }] }), { ...CTX, runOpen })[0]!;
    expect(tool({ result: { text: "ok" } }).status).toBe("completed");
    expect(tool({ unrecorded: true }).status).toBe("completed");
    expect(tool({ result: { text: "boom", isError: true } })).toMatchObject({ status: "failed", outputIndicatesFailure: true });
    expect(tool({}).status).toBe("running");
    expect(tool({}, false).status).toBe("completed");
  });

  test("tool kinds carry their input and output", () => {
    const items = entryItems(
      entry({
        parts: [
          { kind: "tool", name: "Bash", summary: "ls -la", result: { text: "a.txt" } },
          { kind: "tool", name: "Edit", summary: "src/a.ts", result: { text: "updated" } },
          { kind: "tool", name: "Grep", summary: "TODO", result: { text: "C:\\x\\a.ts:12:// TODO\nb.ts" } },
          { kind: "tool", name: "WebFetch", summary: "https://example.com", result: { text: "page" } },
          { kind: "tool", name: "Read", summary: "/a.md", result: { text: "body" } },
        ],
      }),
      CTX,
    );
    expect(items[0]).toMatchObject({ type: "command_execution", title: "Bash", input: "ls -la", output: "a.txt", startedAt: at });
    expect(items[1]).toMatchObject({ type: "file_change", title: "Edit", fileName: "src/a.ts" });
    expect(items[2]).toMatchObject({
      type: "file_search",
      pattern: "TODO",
      results: [{ fileName: "C:\\x\\a.ts", line: 12, preview: "// TODO" }, { fileName: "b.ts" }],
    });
    expect(items[3]).toMatchObject({
      type: "web_search",
      patterns: ["https://example.com"],
      results: [{ url: "https://example.com", snippet: "page" }],
    });
    expect(items[4]).toMatchObject({ type: "dynamic_tool", toolName: "Read", input: "/a.md", output: "body" });
  });

  test("a pending Grok ask is not an item; answered, it maps under the same id", () => {
    const ask = { id: "call-ask", questions: [{ question: "Which?", multi: false, options: [{ label: "A" }] }] };
    const pending = entryItems(
      entry({ parts: [{ kind: "text", text: "asking" }, { kind: "tool", name: "ask_user_question", summary: "Which?", ask }] }),
      CTX,
    );
    expect(pending.map((i) => i.id)).toEqual(["e1:0"]);
    const answered = entryItems(
      entry({ parts: [{ kind: "text", text: "asking" }, { kind: "tool", name: "ask_user_question", summary: "Which?", result: { text: "A" } }] }),
      CTX,
    );
    expect(answered.map((i) => [i.id, i.type])).toEqual([
      ["e1:0", "assistant_message"],
      ["e1:1", "dynamic_tool"],
    ]);
  });
});

describe("toolItemType", () => {
  // Every tool name in the bridge/journal adapter fixtures (claude, pi, cursor, grok tests).
  const FIXTURE_NAMES: [string, ToolItemType][] = [
    ["Read", "dynamic_tool"], // claude.test.ts
    ["Bash", "command_execution"], // claude.test.ts
    ["Grep", "file_search"], // claude.test.ts
    ["result", "dynamic_tool"], // claude.test.ts (orphan result)
    ["read", "dynamic_tool"], // pi.test.ts
    ["Shell", "command_execution"], // cursor.test.ts
    ["read_file", "dynamic_tool"], // grok.test.ts
    ["ask_user_question", "dynamic_tool"], // grok.test.ts
  ];
  test.each(FIXTURE_NAMES)("%s → %s", (name, kind) => {
    expect(toolItemType(name)).toBe(kind);
  });

  test.each([
    ["bash", "command_execution"],
    ["exec", "command_execution"],
    ["run_command", "command_execution"],
    ["MultiEdit", "file_change"],
    ["Write", "file_change"],
    ["NotebookEdit", "file_change"],
    ["apply_patch", "file_change"],
    ["str_replace", "file_change"],
    ["Glob", "file_search"],
    ["find", "file_search"],
    ["search", "file_search"],
    ["WebSearch", "web_search"],
    ["fetch", "web_search"],
    ["ls", "dynamic_tool"],
    ["view", "dynamic_tool"],
    ["mcp__thing__do", "dynamic_tool"],
    ["constructor", "dynamic_tool"],
  ] as [string, ToolItemType][])("%s → %s", (name, kind) => {
    expect(toolItemType(name)).toBe(kind);
  });
});

describe("ids", () => {
  test("an entry's uuid is its key", () => {
    expect(entryKey(entry({ uuid: "abc" }))).toBe("abc");
  });

  test("an empty uuid gets a hash that is stable across calls and differs by content", () => {
    const a = entry({ uuid: "", role: "user", parts: [{ kind: "text", text: "hello" }] });
    const again = entry({ uuid: "", role: "user", parts: [{ kind: "text", text: "hello" }] });
    const b = entry({ uuid: "", role: "user", parts: [{ kind: "text", text: "goodbye" }] });
    expect(entryKey(a)).toMatch(/^h_[0-9a-z]+$/);
    expect(entryKey(a)).toBe(entryKey(again));
    expect(entryKey(a)).not.toBe(entryKey(b));
    expect(entryItems(a, CTX)[0]!.id).toBe(`${entryKey(a)}:0`);
  });
});

describe("helpers", () => {
  test("parseEntryTime", () => {
    expect(parseEntryTime(TS)).toBe(at);
    expect(parseEntryTime("")).toBeNull();
    expect(parseEntryTime("not a date")).toBeNull();
  });

  test("searchResults caps and parses", () => {
    expect(searchResults("a.ts:3:x\n\n  b.ts  ")).toEqual([{ fileName: "a.ts", line: 3, preview: "x" }, { fileName: "b.ts" }]);
    expect(searchResults(Array.from({ length: 500 }, (_, i) => `f${i}`).join("\n"))).toHaveLength(200);
  });

  test("sameItemBody ignores ordinal and updatedAt, not content", () => {
    const [item] = entryItems(entry({ parts: [{ kind: "text", text: "x" }] }), CTX);
    expect(sameItemBody({ ...item!, ordinal: 4, updatedAt: 1 }, item!)).toBe(true);
    expect(sameItemBody({ ...item!, runId: null }, item!)).toBe(false);
  });
});
