import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { TurnItemDraft } from "../threads/events.ts";
import { entryItems, isUserSpeech, type ItemContext } from "../threads/turn-items.ts";
import { parseClaudeTranscript } from "./claude.ts";
import { parsePiTranscript } from "./pi.ts";
import {
  capInput,
  classifyFailure,
  diffDetail,
  diffForNewFile,
  diffFromHunks,
  diffFromReplacements,
  diffStats,
  MAX_DIFF_CHARS,
  MAX_INPUT_CHARS,
  MAX_TODO_STEPS,
  parseResetAt,
  providerFailure,
  todoDetail,
} from "./structured.ts";
import type { TranscriptEntry } from "./types.ts";

// The fixtures are short excerpts with the JSON structure of real Claude Code 2.1.30x and pi session
// rows (keys and nesting as written on disk), with every message replaced by neutral text.
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

const CTX: ItemContext = { threadId: "t1", runId: "r1", runOpen: false, createdAt: 1, updatedAt: 2 };

function items(entries: TranscriptEntry[], harness: string): TurnItemDraft[] {
  return entries.flatMap((e) => entryItems(e, { ...CTX, harness }));
}

function byId(list: TurnItemDraft[], id: string): TurnItemDraft {
  const found = list.find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}: ${list.map((i) => i.id).join(", ")}`);
  return found;
}

describe("structured helpers", () => {
  test("capInput keeps small input whole and cuts big input under the cap", () => {
    expect(capInput({ file_path: "/a.ts" })).toEqual({ input: { file_path: "/a.ts" } });
    expect(capInput("bare")).toEqual({});
    const big = capInput({ content: "x".repeat(50_000), list: Array.from({ length: 500 }, (_, i) => i) });
    expect(big.inputTruncated).toBe(true);
    expect(JSON.stringify(big.input).length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
  });

  test("diffFromHunks renders Claude's structuredPatch as a unified diff", () => {
    const diff = diffFromHunks("a.ts", [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" keep", "-old", "+new"] }]);
    expect(diff).toBe("--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new");
    expect(diffFromHunks("a.ts", [])).toBeNull();
    expect(diffFromHunks("a.ts", [{ nope: 1 }])).toBeNull();
  });

  test("diffFromReplacements keeps shared lines as context", () => {
    const diff = diffFromReplacements("a.ts", [{ oldText: "a\nb\nc", newText: "a\nB\nc" }])!;
    expect(diff.split("\n")).toEqual(["--- a/a.ts", "+++ b/a.ts", "@@ @@", " a", "-b", "+B", " c"]);
    expect(diffStats(diff)).toEqual({ additions: 1, deletions: 1 });
  });

  test("a new file is all additions", () => {
    expect(diffStats(diffForNewFile("n.md", "one\ntwo\n"))).toEqual({ additions: 2, deletions: 0 });
  });

  test("diffDetail counts the whole diff, then caps it at a line", () => {
    const lines = Array.from({ length: 5_000 }, (_, i) => `+line ${i} ${"x".repeat(20)}`);
    const detail = diffDetail("big.ts", ["--- a/big.ts", "+++ b/big.ts", "@@ -0,0 +1,5000 @@", ...lines].join("\n"));
    expect(detail.additions).toBe(5_000);
    expect(detail.truncated).toBe(true);
    expect(detail.diff!.length).toBeLessThanOrEqual(MAX_DIFF_CHARS);
    expect(detail.diff!.endsWith("x")).toBe(true);
    expect(diffDetail("n.ipynb", null, { newStr: "print(1)" })).toEqual({ kind: "diff", fileName: "n.ipynb", newStr: "print(1)" });
  });

  test("todoDetail caps the steps", () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: String(i), text: `step ${i}`, status: "pending" as const }));
    const detail = todoDetail(many);
    expect(detail.steps).toHaveLength(MAX_TODO_STEPS);
    expect(detail.truncated).toBe(true);
  });

  test("failures are classified by their words", () => {
    expect(classifyFailure("You've hit your session limit · resets 2:10am")).toBe("usage_limit");
    expect(classifyFailure("You've hit your weekly limit · resets 9am")).toBe("usage_limit");
    expect(classifyFailure("API Error: Connection dropped (ECONNRESET)")).toBe("transport_error");
    expect(classifyFailure("stale ta_ key for thickAPI [code=authentication_error]")).toBe("permission_error");
    expect(classifyFailure("cursor not_found: requested_model x [code=model_not_found]")).toBe("validation_error");
    expect(classifyFailure("Claude stopped with unclosed content blocks")).toBe("provider_error");
  });

  test("parseResetAt reads a relative duration and a wall-clock time", () => {
    const at = new Date(2026, 9, 18, 23, 0, 0).getTime();
    expect(parseResetAt("Resets in 1h59m50s.", at)).toBe(at + (3600 + 59 * 60 + 50) * 1000);
    // 2:10am is after 11pm, so it is tomorrow's.
    expect(parseResetAt("resets 2:10am (Australia/Brisbane)", at)).toBe(new Date(2026, 9, 19, 2, 10).getTime());
    expect(parseResetAt("resets 11:30pm", at)).toBe(new Date(2026, 9, 18, 23, 30).getTime());
    expect(parseResetAt("resets 9am", at)).toBe(new Date(2026, 9, 19, 9, 0).getTime());
    expect(parseResetAt("Connection error.", at)).toBeNull();
  });

  test("providerFailure prefers the structured reset time and keeps the code", () => {
    const f = providerFailure("You've hit your session limit · resets 2:10am", { code: "rate_limit", resetAt: 5, at: 0 });
    expect(f).toEqual({ class: "usage_limit", message: "You've hit your session limit · resets 2:10am", code: "rate_limit", retryable: null, resetAt: 5 });
    expect(providerFailure("  ", { at: 0 }).message).toBe("The provider returned an error.");
  });
});

describe("Claude fixture → turn items", () => {
  const entries = parseClaudeTranscript(fixture("claude-structured.jsonl"));
  const list = items(entries, "claude");

  test("an Edit carries the diff from structuredPatch and its counts", () => {
    const edit = byId(list, "c0000000-0000-4000-8000-000000000002:0");
    // The row's cwd is C:\demo, so the path is workspace-relative.
    expect(edit).toMatchObject({ type: "file_change", status: "completed", fileName: "src/greet.ts", additions: 2, deletions: 1 });
    if (edit.type !== "file_change") throw new Error("type");
    expect(edit.diffStr).toContain("@@ -3,3 +3,4 @@");
    expect(edit.diffStr).toContain('+export const farewell = "bye";');
  });

  test("a failed Edit keeps the intended diff and the tool's error text", () => {
    const edit = byId(list, "c0000000-0000-4000-8000-000000000004:0");
    expect(edit).toMatchObject({ type: "file_change", status: "failed", deletions: 1, additions: 1 });
    if (edit.type !== "file_change") throw new Error("type");
    // The `<tool_use_error>` envelope is dropped; the words inside are the error.
    expect(edit.errorText).toBe("String to replace not found in file.\nString: export const missing = 1;");
  });

  test("a Write that created a file is all additions", () => {
    expect(byId(list, "c0000000-0000-4000-8000-000000000006:0")).toMatchObject({ type: "file_change", fileName: "C:\\demo\\NOTES.md", additions: 2, deletions: 0 });
  });

  test("a failed Bash keeps its exit code", () => {
    expect(byId(list, "c0000000-0000-4000-8000-000000000008:0")).toMatchObject({ type: "command_execution", status: "failed", exitCode: 1, outputIndicatesFailure: true });
  });

  test("Grep's 'Found N files' header is not a hit", () => {
    const grep = byId(list, "c0000000-0000-4000-8000-000000000010:0");
    expect(grep).toMatchObject({ type: "file_search", results: [{ fileName: "C:\\demo\\src\\greet.ts" }, { fileName: "C:\\demo\\src\\index.ts" }] });
  });

  test("WebFetch is a web_search whose pattern is the URL", () => {
    expect(byId(list, "c0000000-0000-4000-8000-000000000012:0")).toMatchObject({
      type: "web_search",
      patterns: ["https://example.com/docs"],
      results: [{ url: "https://example.com/docs", snippet: "The page describes an example domain." }],
    });
  });

  test("TodoWrite → todo_list with every step, and a non-empty summary", () => {
    const todo = byId(list, "c0000000-0000-4000-8000-000000000014:0");
    expect(todo).toMatchObject({
      type: "todo_list",
      steps: [
        { text: "Rename the constant", status: "completed" },
        { text: "Run the tests", status: "running" },
        { text: "Update the docs", status: "pending" },
      ],
    });
    const part = entries.find((e) => e.uuid === "c0000000-0000-4000-8000-000000000014")!.parts[0]!;
    expect(part.kind === "tool" && part.summary).toBe("3 tasks");
  });

  test("ExitPlanMode → proposed_plan with the whole plan", () => {
    expect(byId(list, "c0000000-0000-4000-8000-000000000016:0")).toMatchObject({
      type: "proposed_plan",
      markdown: "# Rename plan\n\n1. Rename the constant\n2. Run the tests\n3. Update the docs",
    });
  });

  test("Agent → subagent with id, status, model, duration, tokens and the result", () => {
    expect(byId(list, "c0000000-0000-4000-8000-000000000018:0")).toMatchObject({
      type: "subagent",
      title: "Survey the src folder",
      subagentId: "a1b2c3d4e5f6a7b8c",
      driver: "claude",
      prompt: "List the files in src and say what each does.",
      agentStatus: "completed",
      model: "sonnet",
      durationMs: 5400,
      tokens: "12000",
      toolUses: 3,
      result: "Two files: greet.ts exports the greeting, index.ts re-exports it.",
    });
    expect(byId(list, "c0000000-0000-4000-8000-000000000020:0")).toMatchObject({
      type: "subagent",
      agentStatus: "async_launched",
      model: "claude-opus-5-5",
      status: "completed",
    });
  });

  test("the interrupt marker is a run_interrupt_result, not your message", () => {
    const entry = entries.find((e) => e.uuid === "c0000000-0000-4000-8000-000000000022")!;
    expect(entry.role).toBe("note");
    expect(isUserSpeech(entry)).toBe(false);
    expect(byId(list, "c0000000-0000-4000-8000-000000000022:0")).toMatchObject({ type: "run_interrupt_result", message: "Stopped by the user" });
  });

  test("a usage-limit API error → error item, usage_limit, reset from resetsAt", () => {
    expect(byId(list, "c0000000-0000-4000-8000-000000000024:0")).toMatchObject({
      type: "error",
      status: "failed",
      failure: { class: "usage_limit", code: "rate_limit", resetAt: 1792167000 * 1000, message: "You've hit your session limit · resets 2:10am (Australia/Brisbane)" },
    });
    expect(byId(list, "c0000000-0000-4000-8000-000000000025:0")).toMatchObject({
      type: "error",
      failure: { class: "transport_error", message: "API Error: Connection dropped (ECONNRESET)" },
    });
  });

  test("the compaction summary is a compaction item with the text behind it", () => {
    const item = byId(list, "c0000000-0000-4000-8000-000000000026:0");
    expect(item).toMatchObject({ type: "compaction", driver: "claude" });
    if (item.type !== "compaction") throw new Error("type");
    expect(item.summary).toContain("Primary Request and Intent");
  });

  test("assistant usage becomes the entry's context use; an API error row reports none", () => {
    expect(entries.find((e) => e.uuid === "c0000000-0000-4000-8000-000000000002")!.usage).toEqual({
      usedTokens: 2 + 2838 + 34320 + 209,
      inputTokens: 2 + 2838 + 34320,
      cachedInputTokens: 34320,
      outputTokens: 209,
    });
    expect(entries.find((e) => e.uuid === "c0000000-0000-4000-8000-000000000024")!.usage).toBeUndefined();
  });

  test("a call's arguments are kept for the inspector", () => {
    const part = entries.find((e) => e.uuid === "c0000000-0000-4000-8000-000000000012")!.parts[0]!;
    expect(part.kind === "tool" && part.input).toEqual({ url: "https://example.com/docs", prompt: "Summarise the page" });
  });
});

describe("Pi fixture → turn items", () => {
  const entries = parsePiTranscript(fixture("pi-structured.jsonl"));
  const list = items(entries, "pi");

  test("todo → todo_list with the full task list (deleted tasks dropped)", () => {
    expect(byId(list, "m0000002:0")).toMatchObject({
      type: "todo_list",
      steps: [
        { id: "1", text: "Read the config", status: "completed" },
        { id: "2", text: "Sort the keys", status: "running" },
        { id: "4", text: "Run the checks", status: "pending" },
      ],
    });
  });

  test("edit → file_change with the unified patch from details", () => {
    const edit = byId(list, "m0000004:0");
    expect(edit).toMatchObject({ type: "file_change", fileName: "config.json", additions: 2, deletions: 2, status: "completed" });
    if (edit.type !== "file_change") throw new Error("type");
    expect(edit.diffStr).toContain("@@ -1,4 +1,4 @@");
  });

  test("a failed edit keeps the intended diff and the error text", () => {
    const edit = byId(list, "m0000006:0");
    expect(edit).toMatchObject({ type: "file_change", status: "failed", additions: 1, deletions: 1 });
    if (edit.type !== "file_change") throw new Error("type");
    expect(edit.errorText).toContain("Could not find the exact text");
  });

  test("subagent → subagent item with model, tokens, duration and tool count", () => {
    expect(byId(list, "m0000008:0")).toMatchObject({
      type: "subagent",
      title: "Check the schema",
      subagentId: "c3d4e5f6a7b8c9d0e",
      driver: "pi",
      model: "anthropic/claude-haiku-4-5",
      tokens: "5.6k",
      durationMs: 21371,
      toolUses: 4,
      agentStatus: "stopped",
      status: "completed",
      result: "No mismatches found.",
    });
  });

  test("an error turn with no content is kept as an error item (usage limit with a reset)", () => {
    const quota = byId(list, "m0000010:0");
    expect(quota).toMatchObject({ type: "error", status: "failed", failure: { class: "usage_limit", code: "insufficient_quota" } });
    if (quota.type !== "error") throw new Error("type");
    expect(quota.failure.resetAt).toBe(1792288831000 + (3600 + 59 * 60 + 50) * 1000);
    expect(byId(list, "m0000011:0")).toMatchObject({ type: "error", failure: { class: "transport_error", message: "Connection error." } });
  });

  test("an aborted turn adds no error", () => {
    expect(list.filter((i) => i.id.startsWith("m0000012")).map((i) => i.type)).toEqual(["reasoning"]);
  });

  test("usage: input plus cache plus output, with the cost", () => {
    expect(entries.find((e) => e.uuid === "m0000002")!.usage).toEqual({
      usedTokens: 4 + 10394 + 208,
      inputTokens: 4 + 10394,
      cachedInputTokens: 0,
      outputTokens: 208,
      cost: 0.00140365,
    });
    expect(entries.find((e) => e.uuid === "m0000010")!.usage).toBeUndefined();
  });
});

describe("Claude fixture with cwd and background agents → turn items", () => {
  const entries = parseClaudeTranscript(fixture("claude-subagents.jsonl"));
  const list = items(entries, "claude");
  const row = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}:0`;

  test("an edit under the session's cwd shows a workspace-relative path with forward slashes", () => {
    const edit = byId(list, row(2));
    expect(edit).toMatchObject({ type: "file_change", fileName: "docs/notes.md", additions: 1, deletions: 1 });
    if (edit.type !== "file_change") throw new Error("type");
    expect(edit.diffStr).toContain("+++ b/docs/notes.md");
    // The capped arguments stay verbatim.
    expect(edit.title).toBe("Edit");
    const part = entries.find((e) => e.uuid === row(2).slice(0, -2))!.parts[0]!;
    expect(part.kind === "tool" && (part.input as { file_path: string }).file_path).toBe("C:\\work\\demo\\docs\\notes.md");
  });

  test("a path outside the cwd is left as it is", () => {
    expect(byId(list, row(4))).toMatchObject({ type: "dynamic_tool", input: "C:\\Other\\outside.txt" });
  });

  test("Grep hits under the cwd are relative; the matched text keeps its backslashes", () => {
    expect(byId(list, row(6))).toMatchObject({
      type: "file_search",
      results: [{ fileName: "docs/notes.md", line: 2, preview: "two edited \\ back" }],
    });
  });

  test("a background Agent hides the launch boilerplate and takes the hand-back as its result", () => {
    const agent = byId(list, row(8));
    expect(agent).toMatchObject({
      type: "subagent",
      title: "Survey the docs",
      subagentId: "a111111111111111a",
      prompt: "List the docs and say which are stale.",
      status: "completed",
      agentStatus: "completed",
      tokens: "30216",
      toolUses: 4,
      durationMs: 12706,
      result: "Two docs: notes.md is current.\n\n- README.md is stale.",
    });
    if (agent.type !== "subagent") throw new Error("type");
    expect(agent.result).not.toContain("Async agent launched");
  });

  test("the hand-back and the matched task-notification leave no rows of their own", () => {
    expect(list.some((i) => i.id === row(12) || i.id === row(13))).toBe(false);
  });

  test("a failed background agent turns failed and keeps the notification's result", () => {
    expect(byId(list, row(14))).toMatchObject({
      type: "subagent",
      status: "failed",
      agentStatus: "failed",
      result: "The agent hit an error: network unreachable.",
    });
  });

  test("a task-notification for a call outside the window stays a note", () => {
    expect(byId(list, row(17))).toMatchObject({ type: "system_notice", message: 'Background command "bun test" completed (exit code 0)' });
  });

  test("before its notification lands, a background agent reads as launched with an empty result", () => {
    const head = fixture("claude-subagents.jsonl").split("\n").slice(0, 9).join("\n");
    const agent = byId(items(parseClaudeTranscript(head), "claude"), row(8));
    expect(agent).toMatchObject({ type: "subagent", agentStatus: "async_launched", result: "" });
  });

  test("an MCP call keeps its raw tool name (web2 labels it)", () => {
    expect(byId(list, row(10))).toMatchObject({ type: "dynamic_tool", toolName: "mcp__claude-in-chrome__navigate", input: "https://example.com/" });
  });
});
