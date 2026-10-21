import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TurnItem } from "../../shared/v2/contracts.ts";
import { CAN_SYMLINK } from "../platform-support.ts";
import { createTranscriptReader, latestActivity, type TranscriptBody } from "./subagent-transcript.ts";

let root: string;
let project: string; // the thread's own log directory
let outside: string;

const MAIN = "sess1";
const jl = (...rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "t33-"));
  project = join(root, "project");
  outside = join(root, "elsewhere");
  await mkdir(join(project, MAIN, "subagents"), { recursive: true });
  await mkdir(join(project, MAIN, "tasks"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(project, `${MAIN}.jsonl`), "");

  // Claude: the agent's own log (rows marked isSidechain).
  await writeFile(
    join(project, MAIN, "subagents", "agent-abc123.jsonl"),
    jl(
      { type: "user", isSidechain: true, agentId: "abc123", uuid: "u1", timestamp: "2026-10-21T01:00:00.000Z", message: { role: "user", content: "Survey the src folder." } },
      {
        type: "assistant",
        isSidechain: true,
        agentId: "abc123",
        uuid: "a1",
        timestamp: "2026-10-21T01:00:05.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls src" } }] },
      },
    ),
  );

  // Pi: the task log, in Pi's own format.
  const piRow = (id: string, message: Record<string, unknown>) => ({ type: "message", id, parentId: null, timestamp: "2026-10-21T01:00:00.000Z", message });
  await writeFile(
    join(project, MAIN, "tasks", "t_1.jsonl"),
    jl(
      piRow("p0", { role: "user", content: [{ type: "text", text: "Fix PR 1153." }] }),
      piRow("p1", { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "git status" } }] }),
      piRow("p2", { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "clean" }] }),
      piRow("p3", { role: "assistant", content: [{ type: "text", text: "Nothing to do." }] }),
    ),
  );
  await writeFile(join(outside, "stolen.jsonl"), jl(piRow("x", { role: "user", content: [{ type: "text", text: "secret" }] })));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function subagent(id: string, fields: Record<string, unknown>): TurnItem {
  return {
    id,
    threadId: "t1",
    runId: "r1",
    ordinal: Number(id.replace(/\D/g, "")) || 0,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    createdAt: 1,
    updatedAt: 1,
    type: "subagent",
    origin: "provider_native",
    providerInstanceId: "x",
    childThreadId: null,
    prompt: "",
    result: null,
    ...fields,
  } as unknown as TurnItem;
}

function reader(items: TurnItem[], opts: Record<string, unknown> = {}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const store = {
    getTurnItem: (id: string) => byId.get(id) ?? null,
    recentItems: (threadId: string) => items.filter((i) => i.threadId === threadId),
    offsets: new Map([["t1", { path: join(project, `${MAIN}.jsonl`) }]]),
  } as unknown as Parameters<typeof createTranscriptReader>[0]["store"];
  return createTranscriptReader({ store, now: () => 1000, ...opts });
}

const full = async (r: ReturnType<typeof reader>, id: string, q: { size?: number; latest?: boolean } = {}) => {
  const res = await r.load("t1", id, q);
  return res.ok ? (res.body as Extract<TranscriptBody, { items: TurnItem[] }>) : res;
};

describe("Claude agent logs", () => {
  const items = [subagent("s1", { driver: "claude", subagentId: "abc123", agentStatus: "running", transcript: true })];

  test("reads the agent's own conversation, brief first, tool call as a command", async () => {
    const body = (await full(reader(items), "s1")) as Extract<TranscriptBody, { items: TurnItem[] }>;
    expect(body.running).toBe(true);
    expect(body.items.map((i) => i.type)).toEqual(["user_message", "assistant_message", "command_execution"]);
    expect(body.items[0]).toMatchObject({ text: "Survey the src folder." });
    expect(body.items[2]).toMatchObject({ input: "ls src", status: "running" }); // no result yet, agent running
    expect(body.items.map((i) => i.ordinal)).toEqual([0, 1, 2]);
  });

  test("an unchanged file is a tiny answer", async () => {
    const r = reader(items);
    const first = (await full(r, "s1")) as { size: number };
    const again = await r.load("t1", "s1", { size: first.size });
    expect(again).toEqual({ ok: true, body: { ok: true, unchanged: true, size: first.size } });
  });

  test("?latest gives the newest thing the agent did", async () => {
    const res = await reader(items).load("t1", "s1", { latest: true });
    expect(res).toMatchObject({ ok: true, body: { latest: { label: "Running", text: "ls src" }, running: true, toolCount: 1 } });
  });

  test("a finished agent's open tool call is not shown as running", async () => {
    const done = [subagent("s1", { driver: "claude", subagentId: "abc123", agentStatus: "completed", transcript: true })];
    const body = (await full(reader(done), "s1")) as Extract<TranscriptBody, { items: TurnItem[] }>;
    expect(body.running).toBe(false);
    expect(body.items[2]).toMatchObject({ status: "completed" });
  });

  test("an agent id that is not a plain id never reaches a file name", async () => {
    for (const bad of ["../../x", "a/b", "a b", ""]) {
      const res = await reader([subagent("s1", { driver: "claude", subagentId: bad })]).load("t1", "s1", {});
      expect(res.ok).toBe(false);
    }
  });

  test("an agent that has no log is a 404", async () => {
    const res = await reader([subagent("s1", { driver: "claude", subagentId: "nope" })]).load("t1", "s1", {});
    expect(res).toEqual({ ok: false, status: 404, reason: "no-transcript" });
  });
});

describe("Pi agent logs", () => {
  const path = () => join(project, MAIN, "tasks", "t_1.jsonl");

  test("takes the path from a later check of the same agent, and reads the log", async () => {
    const items = [
      subagent("s1", { driver: "pi", subagentId: "fd9e-1", agentStatus: "background" }),
      subagent("s2", { driver: "pi", subagentId: "fd9e-1", agentStatus: "running", transcriptPath: path(), transcript: true }),
    ];
    // Asked through the launch item, which has no path of its own.
    const body = (await full(reader(items), "s1")) as Extract<TranscriptBody, { items: TurnItem[] }>;
    expect(body.running).toBe(true);
    expect(body.items.map((i) => i.type)).toEqual(["user_message", "command_execution", "assistant_message"]);
    expect(body.items[1]).toMatchObject({ input: "git status", output: "clean" });
  });

  test("an agent never checked has no path yet", async () => {
    const res = await reader([subagent("s1", { driver: "pi", subagentId: "fd9e-1" })]).load("t1", "s1", {});
    expect(res).toEqual({ ok: false, status: 404, reason: "no-transcript" });
  });

  test("a recorded path outside the thread's own log directory is refused", async () => {
    const res = await reader([subagent("s1", { driver: "pi", subagentId: "x-1", transcriptPath: join(outside, "stolen.jsonl") })]).load("t1", "s1", {});
    expect(res).toEqual({ ok: false, status: 404, reason: "no-transcript" });
  });

  test("a recorded path that is not a .jsonl log is refused", async () => {
    await writeFile(join(project, MAIN, "tasks", "notes.txt"), "x");
    const res = await reader([subagent("s1", { driver: "pi", subagentId: "x-1", transcriptPath: join(project, MAIN, "tasks", "notes.txt") })]).load("t1", "s1", {});
    expect(res.ok).toBe(false);
  });

  test.skipIf(!CAN_SYMLINK)("a symlink inside the directory that points outside is refused", async () => {
    const link = join(project, MAIN, "tasks", "link.jsonl");
    await symlink(join(outside, "stolen.jsonl"), link);
    const res = await reader([subagent("s1", { driver: "pi", subagentId: "x-1", transcriptPath: link })]).load("t1", "s1", {});
    expect(res.ok).toBe(false);
  });

  test("only the newest items are returned over the cap, and the view says it starts partway", async () => {
    const items = [subagent("s1", { driver: "pi", subagentId: "fd9e-1", transcriptPath: path() })];
    const body = (await full(reader(items, { maxItems: 2 }), "s1")) as Extract<TranscriptBody, { items: TurnItem[] }>;
    expect(body.items).toHaveLength(2);
    expect(body.cutHead).toBe(true);
    expect(body.items.map((i) => i.ordinal)).toEqual([1, 2]); // keeps its place in the log, not renumbered
  });
});

describe("who may ask", () => {
  test("an item of another thread, an unknown item and a non-subagent item are all 404", async () => {
    const a = subagent("s1", { driver: "claude", subagentId: "abc123", threadId: "t2" });
    const msg = { ...subagent("m1", {}), type: "assistant_message", text: "hi" } as unknown as TurnItem;
    const r = reader([a, msg]);
    expect((await r.load("t1", "s1", {})).ok).toBe(false);
    expect((await r.load("t1", "nope", {})).ok).toBe(false);
    expect((await r.load("t1", "m1", {})).ok).toBe(false);
  });

  test("another harness has no agent log to read", async () => {
    const res = await reader([subagent("s1", { driver: "codex", subagentId: "abc123" })]).load("t1", "s1", {});
    expect(res).toEqual({ ok: false, status: 404, reason: "unsupported-harness" });
  });
});

describe("latestActivity", () => {
  const mk = (fields: Record<string, unknown>) => ({ id: "i", threadId: "t1", runId: null, ordinal: 0, status: "completed", title: null, startedAt: null, completedAt: null, createdAt: 1, updatedAt: 1, ...fields }) as unknown as TurnItem;
  test("names the newest action", () => {
    expect(latestActivity([mk({ type: "assistant_message", text: "Done." }), mk({ type: "file_change", fileName: "src/a.ts" })])).toEqual({ label: "Editing", text: "src/a.ts" });
    expect(latestActivity([mk({ type: "reasoning", text: "**Checking the diff**" })])).toEqual({ label: "Thinking", text: "**Checking the diff**" });
    expect(latestActivity([mk({ type: "user_message", text: "brief" })])).toBeNull();
  });
});
