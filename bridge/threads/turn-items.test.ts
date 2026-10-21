import { describe, expect, test } from "bun:test";

import type { TurnItem } from "../../shared/v2/contracts.ts";
import type { TranscriptEntry } from "../journal/types.ts";
import {
  entryItems,
  entryKey,
  type ItemContext,
  parseEntryTime,
  parseJournalAttachmentId,
  sameItemBody,
  searchResults,
  shortHash,
  splitUploads,
  uploadNameOf,
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

  test("note → system_notice; a compaction summary → compaction with the text as its summary", () => {
    const [note] = entryItems(entry({ role: "note", parts: [{ kind: "text", text: "a task finished" }] }), CTX);
    expect(note).toMatchObject({ type: "system_notice", message: "a task finished" });
    const [summary] = entryItems(entry({ role: "summary", parts: [{ kind: "text", text: "long summary" }] }), { ...CTX, harness: "claude" });
    expect(summary).toMatchObject({ type: "compaction", status: "completed", driver: "claude", summary: "long summary" });
  });

  test("an error part → T3's error item (failed, the failure as written)", () => {
    const failure = { class: "usage_limit" as const, message: "You've hit your session limit · resets 2:10am", code: "rate_limit", retryable: null, resetAt: 123 };
    const [item] = entryItems(entry({ parts: [{ kind: "text", text: failure.message, error: failure }] }), CTX);
    expect(item).toMatchObject({ type: "error", status: "failed", failure });
  });

  test("an interrupt marker → run_interrupt_result, never a user message", () => {
    const [item] = entryItems(entry({ role: "note", parts: [{ kind: "text", text: "Interrupted", notice: "interrupted" }] }), CTX);
    expect(item).toMatchObject({ type: "run_interrupt_result", message: "Interrupted", status: "completed" });
  });

  test("a file change carries its diff, counts, and the error text when it failed", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-a\n+b";
    const ok = entryItems(
      entry({ parts: [{ kind: "tool", name: "Edit", summary: "x.ts", detail: { kind: "diff", fileName: "/p/x.ts", diff, additions: 1, deletions: 1 }, result: { text: "updated" } }] }),
      CTX,
    )[0]!;
    expect(ok).toMatchObject({ type: "file_change", fileName: "/p/x.ts", diffStr: diff, additions: 1, deletions: 1, status: "completed" });
    expect(ok).not.toHaveProperty("errorText");
    const failed = entryItems(
      entry({ parts: [{ kind: "tool", name: "Edit", summary: "x.ts", detail: { kind: "diff", fileName: "x.ts", diff }, result: { text: "String to replace not found", isError: true } }] }),
      CTX,
    )[0]!;
    expect(failed).toMatchObject({ type: "file_change", status: "failed", diffStr: diff, errorText: "String to replace not found" });
  });

  test("an old part with no detail still maps as before (stored payloads from older bridges)", () => {
    const [item] = entryItems(entry({ parts: [{ kind: "tool", name: "Edit", summary: "src/a.ts", result: { text: "updated" } }] }), CTX);
    expect(item).toMatchObject({ type: "file_change", fileName: "src/a.ts" });
    expect(item).not.toHaveProperty("diffStr");
  });

  test("todo, plan and subagent details → T3's todo_list, proposed_plan and subagent items", () => {
    const items = entryItems(
      entry({
        parts: [
          { kind: "tool", name: "todo", summary: "x", detail: { kind: "todo", steps: [{ id: "1", text: "Write tests", status: "running" }] }, result: { text: "ok" } },
          { kind: "tool", name: "ExitPlanMode", summary: "# Plan", detail: { kind: "plan", markdown: "# Plan\n\n1. Do it" }, result: { text: "approved" } },
          {
            kind: "tool",
            name: "Agent",
            summary: "Survey files",
            detail: { kind: "subagent", agentId: "ag1", title: "Survey files", prompt: "look", status: "completed", model: "claude-sonnet-5-5", durationMs: 5000, tokens: "12000", toolUses: 3 },
            result: { text: "Found three." },
          },
          { kind: "tool", name: "subagent", summary: "x", detail: { kind: "subagent", status: "error" }, result: { text: "died" } },
        ],
      }),
      { ...CTX, harness: "claude" },
    );
    expect(items[0]).toMatchObject({ type: "todo_list", planId: "e1:0", steps: [{ id: "1", text: "Write tests", status: "running" }] });
    expect(items[1]).toMatchObject({ type: "proposed_plan", planId: "e1:1", markdown: "# Plan\n\n1. Do it", streaming: false });
    expect(items[2]).toMatchObject({
      type: "subagent",
      title: "Survey files",
      subagentId: "ag1",
      origin: "provider_native",
      driver: "claude",
      childThreadId: null,
      prompt: "look",
      result: "Found three.",
      model: "claude-sonnet-5-5",
      agentStatus: "completed",
      durationMs: 5000,
      tokens: "12000",
      toolUses: 3,
      status: "completed",
    });
    expect(items[3]).toMatchObject({ type: "subagent", status: "failed", subagentId: "e1:3" });
  });

  test("an agent's own log can be opened: Claude by its agent id, Pi by the path a check named", () => {
    const sub = (detail: Record<string, unknown>) => ({ kind: "tool" as const, name: "Agent", summary: "x", detail: { kind: "subagent" as const, ...detail }, result: { text: "ok" } });
    const claude = entryItems(entry({ parts: [sub({ agentId: "abc123" }), sub({})] }), { ...CTX, harness: "claude" });
    expect(claude[0]).toMatchObject({ type: "subagent", transcript: true });
    expect(claude[1]).not.toHaveProperty("transcript"); // a synthetic key names no file
    const pi = entryItems(entry({ parts: [sub({ agentId: "p-1" }), sub({ agentId: "p-1", transcriptPath: "C:\s\tasks\a.jsonl" })] }), { ...CTX, harness: "pi" });
    expect(pi[0]).not.toHaveProperty("transcript"); // a call with no brief and no path (a bare check) names no log
    const launched = entryItems(entry({ parts: [sub({ agentId: "p-2", prompt: "Do the thing." })] }), { ...CTX, harness: "pi" });
    expect(launched[0]).toMatchObject({ transcript: true }); // a launch: its log is found by the brief
    expect(pi[1]).toMatchObject({ transcript: true, transcriptPath: "C:\s\tasks\a.jsonl" });
  });

  test("a dynamic tool keeps its capped arguments as rawInput; a command its exit code", () => {
    const items = entryItems(
      entry({
        parts: [
          { kind: "tool", name: "mcp__x__y", summary: "go", input: { a: 1, b: "two" }, result: { text: "ok" } },
          { kind: "tool", name: "Bash", summary: "false", result: { text: "Exit code 2", isError: true, exitCode: 2 } },
        ],
      }),
      CTX,
    );
    expect(items[0]).toMatchObject({ type: "dynamic_tool", input: "go", rawInput: { a: 1, b: "two" } });
    expect(items[1]).toMatchObject({ type: "command_execution", exitCode: 2, outputIndicatesFailure: true });
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
    ["shell_command", "command_execution"], // fixtures/codex-basic.jsonl
    ["apply_patch", "file_change"], // fixtures/codex-basic.jsonl
    ["exec_command", "command_execution"], // fixtures/codex-basic.jsonl
    ["web_search", "web_search"], // fixtures/codex-basic.jsonl
    ["shell", "command_execution"], // fixtures/codex-basic.jsonl, codex-paginated.jsonl (local_shell_call)
    ["write_stdin", "command_execution"], // codex.test.ts
    ["update_plan", "dynamic_tool"], // codex.test.ts
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

  test("searchResults drops Claude's Grep/Glob header and notes (not file names)", () => {
    expect(searchResults("Found 2 files\nsrc/a.ts\nsrc/b.ts")).toEqual([{ fileName: "src/a.ts" }, { fileName: "src/b.ts" }]);
    expect(searchResults("No files found")).toEqual([]);
    expect(searchResults("Found 1 file limit: 20\nx.ts\n(Results are truncated. Consider using a more specific path or pattern.)")).toEqual([{ fileName: "x.ts" }]);
  });

  test("sameItemBody ignores ordinal and updatedAt, not content", () => {
    const [item] = entryItems(entry({ parts: [{ kind: "text", text: "x" }] }), CTX);
    expect(sameItemBody({ ...item!, ordinal: 4, updatedAt: 1 }, item!)).toBe(true);
    expect(sameItemBody({ ...item!, runId: null }, item!)).toBe(false);
  });
});

describe("attachments", () => {
  const UP = String.raw`C:\Users\op\.sightr\uploads\w1_p2-mgx0a1-0123abcd.png`;
  const NOTE = "/home/op/.sightr/uploads/w1_p2-mgx0a1-89abcdef.md";

  test("splitUploads takes the paths Sightr appended back out of the words", () => {
    expect(splitUploads(`what is this? ${UP}`)).toEqual({
      text: "what is this?",
      attachments: [{ type: "image", id: "u_w1_p2-mgx0a1-0123abcd.png", name: "w1_p2-mgx0a1-0123abcd.png", path: UP, mimeType: "image/png" }],
    });
    expect(splitUploads(`${UP} ${NOTE}`).attachments.map((a) => a.type)).toEqual(["image", "file"]);
    expect(splitUploads(`${UP} ${NOTE}`).text).toBe("");
  });

  test("splitUploads leaves anything that is not a bridge-named upload alone", () => {
    for (const text of [String.raw`see C:\src\uploads\logo.png`, "uploads/a-b-c.png", String.raw`C:\x\notuploads\w1_p2-mgx0a1-0123abcd.png`, "no paths"]) {
      expect(splitUploads(text)).toEqual({ text, attachments: [] });
    }
    expect(uploadNameOf(String.raw`C:\x\uploads\..\w1_p2-mgx0a1-0123abcd.png`)).toBeNull();
  });

  test("a user message's logged image and appended upload both become attachments", () => {
    const image = { mimeType: "image/png", sizeBytes: 70, name: "Pasted image 1", at: 1234, row: "e1", n: 0 };
    const [item] = entryItems(entry({ role: "user", parts: [{ kind: "text", text: `[Image #1] and ${UP}`, images: [image] }] }), { ...CTX, logTag: "tag1" });
    expect(item).toMatchObject({ type: "user_message", text: "[Image #1] and" });
    const attachments = (item as Extract<TurnItem, { type: "user_message" }>).attachments;
    expect(attachments[0]).toEqual({ type: "image", id: `j_tag1_1234_0_${shortHash("e1")}`, name: "Pasted image 1", path: "", mimeType: "image/png", sizeBytes: 70 });
    expect(parseJournalAttachmentId(attachments[0]!.id!)).toEqual({ tag: "tag1", at: 1234, n: 0, rowTag: shortHash("e1") });
    expect(attachments[1]!.id).toBe("u_w1_p2-mgx0a1-0123abcd.png");
  });

  test("a tool's output images ride on its dynamic_tool item; none without a log tag or an offset", () => {
    const tool = (images: NonNullable<Extract<TranscriptEntry["parts"][number], { kind: "tool" }>["images"]>) =>
      entry({ parts: [{ kind: "tool", name: "Read", summary: "logo.png", result: { text: "" }, images }] });
    const image = { mimeType: "image/png", sizeBytes: 70, name: "logo.png", at: 9, row: "r", n: 1 };
    const [withTag] = entryItems(tool([image]), { ...CTX, logTag: "t" });
    expect((withTag as Extract<TurnItem, { type: "dynamic_tool" }>).attachments).toEqual([
      expect.objectContaining({ type: "image", id: `j_t_9_1_${shortHash("r")}`, name: "logo.png" }),
    ]);
    const [noTag] = entryItems(tool([image]), CTX);
    expect("attachments" in noTag!).toBe(false);
    const { at: _at, ...noOffset } = image;
    const [noAt] = entryItems(tool([noOffset]), { ...CTX, logTag: "t" });
    expect("attachments" in noAt!).toBe(false);
    expect(parseJournalAttachmentId("j_../x_1_0_a")).toBeNull();
  });
});
