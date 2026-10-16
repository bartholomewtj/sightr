import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_CONTEXT_PREFIXES,
  CodexTranscriptSource,
  isCodexContextText,
  isCodexSessionId,
  MAX_DAY_DIRS,
  parseCodexTranscript,
  readToolOutput,
} from "./codex.ts";
import type { TranscriptEntry, TranscriptPart } from "./types.ts";

// Fixtures follow the rollout record shapes in the Codex source (openai/codex 4eb4a654: history/src/lib.rs
// RolloutLine, rollout_payload.rs, protocol/src/models.rs ResponseItem). Not a live capture: Codex was not
// installed where this was built. All conversation text is invented.
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const BASIC = fixture("codex-basic.jsonl");
const PAGINATED = fixture("codex-paginated.jsonl");

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;
const tools = (entries: TranscriptEntry[]) =>
  entries.flatMap((e) => e.parts.filter((p): p is ToolPart => p.kind === "tool"));
const tool = (entries: TranscriptEntry[], name: string) => tools(entries).find((t) => t.name === name);

const line = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ timestamp: "2026-10-17T05:00:00.000Z", ...extra, type: "response_item", payload });

describe("isCodexSessionId", () => {
  test.each([
    ["a v4 uuid", "715d7796-b4de-4f46-a11c-fbbdd8ca965b", true],
    ["a v7 uuid", "019a2f4e-1c3d-7b8a-9e0f-1a2b3c4d5e6f", true],
    ["upper case", "019A2F4E-1C3D-7B8A-9E0F-1A2B3C4D5E6F", true],
    ["a traversal attempt", "../../secrets", false],
    ["a uuid with a traversal tail", "019a2f4e-1c3d-7b8a-9e0f-1a2b3c4d5e6f/../x", false],
    ["empty", "", false],
    ["too long", "019a2f4e-1c3d-7b8a-9e0f-1a2b3c4d5e6f0", false],
  ])("%s → %s", (_label, value, expected) => {
    expect(isCodexSessionId(value)).toBe(expected);
  });
});

describe("parseCodexTranscript: codex-basic.jsonl", () => {
  const entries = parseCodexTranscript(BASIC);

  test("reads the turns in order, skipping meta, context, events and unknown records", () => {
    expect(entries.map((e) => [e.role, e.parts.map((p) => (p.kind === "tool" ? `tool:${p.name}` : p.kind))])).toEqual([
      ["user", ["text"]],
      ["assistant", ["thinking"]],
      ["assistant", ["text"]],
      ["assistant", ["tool:shell_command"]],
      ["assistant", ["tool:apply_patch"]],
      ["assistant", ["tool:exec_command"]],
      ["assistant", ["tool:web_search"]],
      ["assistant", ["text"]],
      ["user", ["text"]],
      ["assistant", ["tool:shell"]],
    ]);
  });

  test("user then assistant text", () => {
    expect(entries[0]).toMatchObject({ role: "user", ts: "2026-10-17T03:00:01.020Z", parts: [{ kind: "text", text: "Add a greeting to the README." }] });
    expect(entries[2]).toMatchObject({ uuid: "msg_basic_1", role: "assistant", parts: [{ kind: "text", text: "I'll check the README first." }] });
    expect(entries[7]).toMatchObject({ uuid: "msg_basic_2", parts: [{ kind: "text", text: "Added a greeting to the README." }] });
  });

  test("a reasoning summary becomes thinking; encrypted-only reasoning is dropped", () => {
    expect(entries[1]).toMatchObject({ uuid: "rs_basic_1", parts: [{ kind: "thinking", text: "**Looking at the README**" }] });
    expect(entries.some((e) => e.uuid === "rs_basic_2")).toBe(false);
  });

  test("a tool call and its output merge into one tool part with a result", () => {
    expect(tool(entries, "shell_command")).toEqual({
      kind: "tool",
      name: "shell_command",
      summary: "cat README.md",
      result: { text: "# Demo\n" },
    });
    expect(tool(entries, "apply_patch")).toEqual({
      kind: "tool",
      name: "apply_patch",
      summary: "README.md",
      result: { text: "Success. Updated the following files:\nM README.md\n" },
    });
    expect(entries[3]!.uuid).toBe("fc_basic_1");
  });

  test("a failing exit code sets isError and the header is dropped", () => {
    expect(tool(entries, "exec_command")).toEqual({
      kind: "tool",
      name: "exec_command",
      summary: "npm test",
      result: { text: "npm ERR! missing script: test\n", isError: true },
    });
  });

  test("a tool call with no output yet has no result; a shell argv reads as its script", () => {
    expect(tool(entries, "shell")).toEqual({ kind: "tool", name: "shell", summary: "git status --short" });
  });

  test("a finished web search is complete with nothing recorded", () => {
    expect(tool(entries, "web_search")).toEqual({ kind: "tool", name: "web_search", summary: "markdown greeting conventions", unrecorded: true });
  });

  test("injected context (environment, AGENTS.md) and developer messages are not user turns", () => {
    const texts = entries.flatMap((e) => e.parts.map((p) => (p.kind === "tool" ? p.summary : p.text)));
    expect(texts.some((t) => t.includes("environment_context") || t.includes("AGENTS.md") || t.includes("permissions"))).toBe(false);
    expect(entries.filter((e) => e.role === "user")).toHaveLength(2);
  });
});

describe("parseCodexTranscript: codex-paginated.jsonl", () => {
  const entries = parseCodexTranscript(PAGINATED);

  test("ordinals key entries that have no id of their own", () => {
    expect(entries.map((e) => [e.uuid, e.role])).toEqual([
      ["o3", "user"],
      ["o4", "assistant"],
      ["o5", "assistant"],
      ["o8", "note"],
      ["o9", "assistant"],
      ["o12", "assistant"],
    ]);
  });

  test("raw reasoning content stands in for an empty summary", () => {
    expect(entries[1]!.parts).toEqual([{ kind: "thinking", text: "Need to run lint." }]);
  });

  test("a local shell call takes its output by call id; the legacy JSON output reports its exit code", () => {
    expect(entries[2]!.parts).toEqual([
      { kind: "tool", name: "shell", summary: "bun run lint", result: { text: "2 problems\n", isError: true } },
    ]);
  });

  test("a compaction is a note; the interrupt marker is not a user turn", () => {
    expect(entries[3]!.parts).toEqual([{ kind: "text", text: "Context compacted" }]);
    expect(entries.filter((e) => e.role === "user")).toHaveLength(1);
  });

  test("an output whose call is outside the window is kept as its own entry", () => {
    expect(entries[5]!.parts).toEqual([{ kind: "tool", name: "result", summary: "", result: { text: "orphan output" } }]);
  });
});

describe("parseCodexTranscript: robustness and ids", () => {
  test("unknown record types and garbage lines are skipped, never thrown", () => {
    const text = [
      "not json",
      JSON.stringify({ type: "response_item" }),
      JSON.stringify({ type: "response_item", payload: "string" }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "oops" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call" } }),
      JSON.stringify({ type: "world_state", payload: { x: 1 } }),
      JSON.stringify([1, 2, 3]),
      "null",
      line({ type: "agent_message", author: "a", recipient: "b", content: [] }),
      line({ type: "message", role: "assistant", content: [{ type: "output_text", text: "kept" }] }),
    ].join("\n");
    const entries = parseCodexTranscript(text);
    expect(entries.map((e) => e.parts.map((p) => (p.kind === "tool" ? p.name : p.text)))).toEqual([["oops"], ["tool"], ["kept"]]);
  });

  test("a clipped first line is skipped", () => {
    const cut = BASIC.indexOf("\n", BASIC.indexOf("Add a greeting")) + 1;
    const clipped = BASIC.slice(BASIC.indexOf("Add a greeting") - 10);
    expect(clipped.startsWith("{")).toBe(false);
    const entries = parseCodexTranscript(clipped);
    expect(entries[0]!.role).toBe("assistant");
    expect(parseCodexTranscript(BASIC.slice(cut))[0]!.uuid).toBe("rs_basic_1");
  });

  test("ids are stable across re-parses and do not depend on where the window starts", () => {
    for (const text of [BASIC, PAGINATED]) {
      const full = parseCodexTranscript(text);
      expect(parseCodexTranscript(text)).toEqual(full);
      expect(new Set(full.map((e) => e.uuid)).size).toBe(full.length);
      const byId = new Map(full.map((e) => [e.uuid, e]));
      // Every line start: the window's entries are the full parse's, with the same ids. A tool output
      // whose call was cut off is the only entry the full parse lacks.
      for (let at = text.indexOf("\n") + 1; at > 0 && at < text.length; at = text.indexOf("\n", at) + 1) {
        for (const e of parseCodexTranscript(text.slice(at))) {
          if (e.parts[0]?.kind === "tool" && e.parts[0].summary === "" && !byId.has(e.uuid)) continue;
          expect(byId.get(e.uuid)?.ts).toBe(e.ts);
        }
      }
    }
  });

  test("an entry with no id and no ordinal is keyed by a hash, with a counter on repeats", () => {
    const say = line({ type: "message", role: "user", content: [{ type: "input_text", text: "again" }] });
    const ids = parseCodexTranscript([say, say].join("\n")).map((e) => e.uuid);
    expect(ids[0]).toMatch(/^h_[0-9a-z]+$/);
    expect(ids[1]).toBe(`${ids[0]}~1`);
    expect(parseCodexTranscript(say)[0]!.uuid).toBe(ids[0]!);
  });

  test("long tool output is truncated", () => {
    const text = [
      line({ type: "function_call", name: "shell_command", arguments: "{\"command\":\"yes\"}", call_id: "c1" }),
      line({ type: "function_call_output", call_id: "c1", output: `Exit code: 0\nWall time: 1 seconds\nOutput:\n${"y\n".repeat(5000)}` }),
    ].join("\n");
    const result = tools(parseCodexTranscript(text))[0]!.result!;
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(2000);
  });

  test("write_stdin, update_plan and MCP-style calls get a readable summary", () => {
    const text = [
      line({ type: "function_call", name: "write_stdin", arguments: "{\"session_id\":3,\"chars\":\"q\\n\"}", call_id: "c1" }),
      line({ type: "function_call", name: "update_plan", arguments: "{\"explanation\":\"Two steps\",\"plan\":[]}", call_id: "c2" }),
      line({ type: "function_call", name: "mcp__docs__search", arguments: "{\"query\":\"rollouts\"}", call_id: "c3" }),
      line({ type: "function_call", name: "odd", arguments: "not json", call_id: "c4" }),
    ].join("\n");
    expect(tools(parseCodexTranscript(text)).map((t) => [t.name, t.summary])).toEqual([
      ["write_stdin", "q"],
      ["update_plan", "Two steps"],
      ["mcp__docs__search", "rollouts"],
      ["odd", "not json"],
    ]);
  });
});

describe("readToolOutput", () => {
  test.each([
    ["exit 0 header", "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nok", { text: "ok", isError: false }],
    ["exit 2 header", "Exit code: 2\nWall time: 0.1 seconds\nTotal output lines: 9\nOutput:\nbad", { text: "bad", isError: true }],
    ["unified exec still running", "Chunk ID: a\nWall time: 1.0 seconds\nProcess running with session ID 7\nOutput:\n…", { text: "…", isError: false }],
    ["plain text", "Success.", { text: "Success.", isError: false }],
    ["text that mentions an exit code in its body", "Output:\nExit code: 1", { text: "Output:\nExit code: 1", isError: false }],
    ["legacy JSON", "{\"output\":\"x\",\"metadata\":{\"exit_code\":0}}", { text: "x", isError: false }],
    ["brace text", "{not json", { text: "{not json", isError: false }],
  ])("%s", (_label, output, expected) => {
    expect(readToolOutput(output)).toEqual(expected);
  });

  test("content items join their text", () => {
    expect(readToolOutput([{ type: "input_text", text: "a" }, { type: "input_image", image_url: "x" }, { type: "input_text", text: "b" }])).toEqual({
      text: "a\nb",
      isError: false,
    });
  });
});

describe("CODEX_CONTEXT_PREFIXES", () => {
  test.each(CODEX_CONTEXT_PREFIXES.map((p) => [p]))("%s is injected context", (prefix) => {
    expect(isCodexContextText(`  ${prefix} body`)).toBe(true);
    expect(isCodexContextText(`  ${prefix.toUpperCase()} body`)).toBe(true);
  });

  test("ordinary user text is not", () => {
    expect(isCodexContextText("Please read <environment_context> and explain it")).toBe(false);
    expect(isCodexContextText("Warning: tests are flaky")).toBe(false);
  });
});

describe("CodexTranscriptSource", () => {
  const ID = "019a2f4e-1c3d-7b8a-9e0f-1a2b3c4d5e6f";
  const OTHER = "019a2f4e-0000-7000-8000-000000000001";
  const made: string[] = [];
  afterEach(async () => {
    for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function tree(): Promise<string> {
    const base = await realpath(await mkdtemp(join(tmpdir(), "sightr-codex-")));
    made.push(base);
    return base;
  }

  async function put(root: string, ymd: [string, string, string], name: string, body = "{}\n"): Promise<string> {
    const dir = join(root, ...ymd);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), body);
    return join(dir, name);
  }

  const rollout = (stamp: string, id: string, suffix = "") => `rollout-${stamp}-${id}${suffix}.jsonl`;

  test("finds YYYY/MM/DD/rollout-…-<id>.jsonl", async () => {
    const root = join(await tree(), "sessions");
    await put(root, ["2026", "10", "16"], rollout("2026-10-16T09-00-00", OTHER));
    const log = await put(root, ["2026", "10", "15"], rollout("2026-10-15T08-30-00", ID));
    const src = new CodexTranscriptSource(root);
    expect(await src.resolve({ kind: "id", value: ID })).toBe(log);
    expect(await src.resolve({ kind: "id", value: ID.toUpperCase() })).toBe(log);
  });

  test("of several files for one thread (a revert), the newest name wins; .zst is not read", async () => {
    const root = join(await tree(), "sessions");
    await put(root, ["2026", "10", "15"], rollout("2026-10-15T08-30-00", ID));
    const newer = await put(root, ["2026", "10", "15"], rollout("2026-10-15T09-00-00", ID, `_${OTHER}`));
    await put(root, ["2026", "10", "16"], `${rollout("2026-10-16T10-00-00", ID)}.zst`);
    expect(await new CodexTranscriptSource(root).resolve({ kind: "id", value: ID })).toBe(newer);
  });

  test("misses return null: no file, a bad id, a path ref, no root", async () => {
    const root = join(await tree(), "sessions");
    await put(root, ["2026", "10", "15"], rollout("2026-10-15T08-30-00", OTHER));
    const src = new CodexTranscriptSource(root);
    expect(await src.resolve({ kind: "id", value: ID })).toBeNull();
    expect(await src.resolve({ kind: "id", value: "../../etc/passwd" })).toBeNull();
    const real = await put(root, ["2026", "10", "15"], rollout("2026-10-15T08-31-00", ID));
    expect(await src.resolve({ kind: "path", value: real })).toBeNull();
    expect(await new CodexTranscriptSource(join(root, "absent")).resolve({ kind: "id", value: ID })).toBeNull();
    expect(await new CodexTranscriptSource([]).resolve({ kind: "id", value: ID })).toBeNull();
  });

  test("a day directory linked to outside the root is refused", async () => {
    const base = await tree();
    const root = join(base, "sessions");
    await put(join(base, "outside"), ["x", "y", "z"], rollout("2026-10-15T08-30-00", ID));
    await mkdir(join(root, "2026", "10"), { recursive: true });
    // A junction needs no privilege on Windows; elsewhere the type is ignored and this is a symlink.
    await symlink(join(base, "outside", "x", "y", "z"), join(root, "2026", "10", "15"), "junction");
    expect(await new CodexTranscriptSource(root).resolve({ kind: "id", value: ID })).toBeNull();
  });

  test(`the walk stops after ${MAX_DAY_DIRS} day directories, newest first`, async () => {
    const root = join(await tree(), "sessions");
    // 12 months × 31 days = 372 day folders; the oldest six are past the cap.
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 31; d++) await mkdir(join(root, "2025", String(m).padStart(2, "0"), String(d).padStart(2, "0")), { recursive: true });
    }
    await put(root, ["2025", "01", "01"], rollout("2025-01-01T00-00-00", ID));
    const recent = await put(root, ["2025", "01", "07"], rollout("2025-01-07T00-00-00", OTHER));
    const src = new CodexTranscriptSource(root);
    expect(await src.resolve({ kind: "id", value: ID })).toBeNull();
    expect(await src.resolve({ kind: "id", value: OTHER })).toBe(recent);
  });

  test("two roots: the first holding the session wins", async () => {
    const base = await tree();
    const a = join(base, "a");
    const b = join(base, "b");
    await mkdir(a, { recursive: true });
    const inB = await put(b, ["2026", "10", "15"], rollout("2026-10-15T08-30-00", ID));
    const src = new CodexTranscriptSource([a, b]);
    expect(await src.resolve({ kind: "id", value: ID })).toBe(inB);
    const inA = await put(a, ["2026", "10", "14"], rollout("2026-10-14T08-30-00", ID));
    expect(await new CodexTranscriptSource([a, b]).resolve({ kind: "id", value: ID })).toBe(inA);
  });

  test("loads and stats the resolved file", async () => {
    const root = join(await tree(), "sessions");
    const log = await put(root, ["2026", "10", "15"], rollout("2026-10-15T08-30-00", ID), BASIC);
    const src = new CodexTranscriptSource(root);
    const path = (await src.resolve({ kind: "id", value: ID }))!;
    expect(path).toBe(log);
    expect((await src.stat(path))?.size).toBe(Buffer.byteLength(BASIC));
    const loaded = await src.load(path);
    expect(loaded.complete).toBe(true);
    expect(parseCodexTranscript(loaded.text)).toEqual(parseCodexTranscript(BASIC));
  });
});
