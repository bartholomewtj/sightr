import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ThreadStatus, TurnItem } from "../../shared/v2/contracts.ts";
import type { PaneRead } from "../herdr-client.ts";
import { conversationRoot, parseClaudeTranscript } from "../journal/claude.ts";
import { parseCodexTranscript } from "../journal/codex.ts";
import { TranscriptStore } from "../journal/store.ts";
import type { AgentSessionRef, JournalAdapter } from "../journal/types.ts";
import type { AgentView, EngineSnapshot } from "../state-engine.ts";
import { claudeRow, memoryLogs, type MemoryLogs } from "../test/journal-fakes.ts";
import { createProject, createThread, project, thread } from "../test/thread-fixtures.ts";
import type { ServerThread } from "./events.ts";
import {
  createJournalIngestor,
  createThreadWatchers,
  type JournalIngestor,
  SCREEN_MAX_BYTES,
  screenText,
} from "./journal-ingest.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";
import { entryItemIds } from "./turn-items.ts";

// ── Harness ──────────────────────────────────────────────────────────────────────────────────────

const T0 = 1_800_000_000_000;
const PANE = "w1:p-t1";

const dirs: string[] = [];
const open: { ingestor: JournalIngestor; store: ThreadStore }[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) {
    r.ingestor.stop();
    await r.ingestor.settled();
    try {
      r.store.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rig {
  store: ThreadStore;
  logs: MemoryLogs;
  ingestor: JournalIngestor;
  watchers: ReturnType<typeof createThreadWatchers>;
  clock: { now: number };
  pane: AgentView;
  readCalls: { paneId: string; source: string; lines: number; format: string }[];
  warnings: string[];
  dbPath: string;
  /** Publish a status the way the herd ingest does, then let the ingestor settle. */
  status(s: ThreadStatus): Promise<void>;
  /** Reopen the store and a fresh ingestor over the same database (a bridge restart). */
  restart(): Rig;
}

function rig(opts: { pollMs?: number; harness?: string; screen?: string; threadOver?: Partial<ServerThread>; parse?: (t: string) => ReturnType<typeof parseClaudeTranscript>; dbPath?: string; logs?: MemoryLogs; seed?: boolean } = {}): Rig {
  const dbPath = opts.dbPath ?? join((() => {
    const d = mkdtempSync(join(tmpdir(), "sightr-journal-ingest-"));
    dirs.push(d);
    return d;
  })(), "threads.sqlite");
  const clock = { now: T0 };
  let n = 0;
  const store = openThreadStore(dbPath, { now: () => clock.now, newId: () => `id${++n}` });
  const harness = opts.harness ?? "claude";
  if (opts.seed !== false) {
    store.append([createProject(project()), createThread(thread("t1", { paneId: PANE, harness, ...opts.threadOver }))]);
  }
  const logs = opts.logs ?? memoryLogs();
  const adapter: JournalAdapter = {
    agent: "claude",
    source: logs.source,
    parse: opts.parse ?? ((t) => parseClaudeTranscript(t)),
    sessionLineage: async (ref: AgentSessionRef) => {
      const path = await logs.source.resolve(ref);
      return path === null ? null : conversationRoot(logs.text(ref.value));
    },
  };
  const pane: AgentView = {
    paneId: PANE,
    terminalId: "term-t1",
    workspaceId: "w1",
    workspaceLabel: "demo",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: harness,
    status: "idle",
    cwd: "C:\\code\\demo",
    focused: false,
    kind: "agent",
    agentSession: { kind: "id", value: "s1" },
  };
  const snap = (): EngineSnapshot => ({ agents: [pane], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" });
  const readCalls: Rig["readCalls"] = [];
  const herdr = {
    async readPane(paneId: string, source: string, lines: number, format = "text"): Promise<PaneRead> {
      readCalls.push({ paneId, source, lines, format });
      return { pane_id: paneId, text: opts.screen ?? "screen text\n\n", truncated: false, revision: 1 };
    },
  };
  const watchers = createThreadWatchers();
  const warnings: string[] = [];
  const ingestor = createJournalIngestor({
    store,
    engine: { current: snap, onUpdate: () => () => {} },
    herdr: herdr as never,
    journals: { claude: adapter },
    transcripts: new TranscriptStore(),
    watchers,
    now: () => clock.now,
    newId: () => `id${++n}`,
    log: (m) => warnings.push(m),
    pollMs: opts.pollMs ?? 1_000_000,
  });
  ingestor.start();
  open.push({ ingestor, store });
  const self: Rig = {
    store,
    logs,
    ingestor,
    watchers,
    clock,
    pane,
    readCalls,
    warnings,
    dbPath,
    async status(s) {
      await ingestor.settled();
      store.append([{ type: "thread.updated", threadId: "t1", payload: { patch: { status: s }, at: clock.now } }]);
      await ingestor.settled();
    },
    restart() {
      ingestor.stop();
      store.close();
      return rig({ ...opts, dbPath, logs, seed: false });
    },
  };
  return self;
}

const items = (r: Rig): TurnItem[] => r.store.recentItems("t1", 10_000);
const itemIds = (r: Rig) => items(r).map((i) => i.id);

async function settle(r: Rig) {
  await r.ingestor.settled();
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────

describe("journal ingest: items and idempotence", () => {
  test("catchUp twice on the same log appends nothing the second time", async () => {
    const r = rig();
    r.logs.write("s1", claudeRow.user("u1", "hello", T0 - 1_000) + claudeRow.assistant("a1", "hi", T0 - 500));
    await r.ingestor.catchUp("t1");
    expect(itemIds(r)).toEqual(["u1:0", "a1:0"]);
    const seq = r.store.lastSequence();
    await r.ingestor.catchUp("t1");
    expect(r.store.lastSequence()).toBe(seq);
    // Even with the offset reset, the same bytes re-read change nothing.
    r.store.offsets.set({ ...r.store.offsets.get("t1")!, size: 0, mtimeMs: 0 });
    await r.ingestor.catchUp("t1");
    expect(r.store.lastSequence()).toBe(seq);
  });

  test("a tool result that lands later updates its item in place", async () => {
    const r = rig();
    r.logs.write("s1", claudeRow.user("u1", "list", T0) + claudeRow.toolUse("a1", "toolu_1", "Bash", { command: "ls" }, T0 + 1));
    await r.status("working");
    expect(items(r).find((i) => i.id === "a1:0")).toMatchObject({ type: "command_execution", status: "running" });
    const ordinal = items(r).find((i) => i.id === "a1:0")!.ordinal;
    r.logs.append("s1", claudeRow.toolResult("x1", "toolu_1", "a.txt", T0 + 2));
    await r.ingestor.catchUp("t1");
    const item = items(r).find((i) => i.id === "a1:0")!;
    expect(item).toMatchObject({ status: "completed", output: "a.txt", ordinal });
  });
});

describe("journal ingest: runs", () => {
  test("working → idle makes one run and attaches the first user message", async () => {
    const r = rig();
    r.logs.write("s1", "");
    await r.ingestor.catchUp("t1"); // the log is known (offset saved), so no backfill below
    r.logs.append("s1", claudeRow.user("u1", "do it", T0 - 1_000));
    await r.status("working");
    r.clock.now += 3_000;
    r.logs.append("s1", claudeRow.assistant("a1", "done", T0 + 2_000));
    await r.status("idle");
    const runs = r.store.listRuns("t1");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ordinal: 1, status: "completed", userItemId: "u1:0", startedAt: T0, completedAt: T0 + 3_000 });
    expect(items(r).map((i) => [i.id, i.runId])).toEqual([
      ["u1:0", runs[0]!.id],
      ["a1:0", runs[0]!.id],
    ]);
  });

  test("a user message read after the run started still opens it (run.updated)", async () => {
    const r = rig();
    r.logs.write("s1", "");
    await r.ingestor.catchUp("t1");
    await r.status("working");
    r.clock.now += 1_000;
    r.logs.append("s1", claudeRow.user("u1", "late", T0 + 500));
    await r.ingestor.catchUp("t1");
    const run = r.store.listRuns("t1")[0]!;
    expect(run.userItemId).toBe("u1:0");
    expect(r.store.eventsAfter(0).some((e) => e.type === "run.updated")).toBe(true);
  });

  test("blocked mid-run does not split it", async () => {
    const r = rig();
    r.logs.write("s1", "");
    await r.ingestor.catchUp("t1");
    await r.status("working");
    await r.status("approval");
    await r.status("working");
    await r.status("input");
    await r.status("working");
    await r.status("done");
    const runs = r.store.listRuns("t1");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("completed");
  });

  test("an error item fails the run and the thread", async () => {
    const r = rig();
    r.logs.write("s1", "");
    await r.ingestor.catchUp("t1");
    await r.status("working");
    const run = r.store.openRun("t1")!;
    r.store.append([
      {
        type: "turn-item.updated",
        threadId: "t1",
        payload: {
          item: {
            id: "err1",
            threadId: "t1",
            runId: run.id,
            status: "failed",
            title: null,
            startedAt: null,
            completedAt: null,
            createdAt: T0,
            updatedAt: T0,
            type: "error",
            failure: { class: "provider_error", message: "overloaded", code: null, retryable: true },
          },
        },
      },
    ]);
    await r.status("idle");
    expect(r.store.getRun(run.id)!.status).toBe("failed");
    expect(r.store.getThread("t1")!.status).toBe("failed");
  });

  test("a Claude usage-limit row fails the run; the interrupt marker ends one interrupted, not as your message", async () => {
    const r = rig();
    r.logs.write("s1", "");
    await r.ingestor.catchUp("t1");
    r.logs.append("s1", claudeRow.user("u1", "go", T0 - 500));
    await r.status("working");
    const limitRow = {
      type: "assistant",
      uuid: "a1",
      timestamp: new Date(T0 + 100).toISOString(),
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      error: "rate_limit",
      apiErrorParams: { rate_limit_info: { status: "rejected", resetsAt: 1_800_003_600 } },
      message: { role: "assistant", content: [{ type: "text", text: "You've hit your session limit · resets 2:10am" }] },
    };
    r.logs.append("s1", `${JSON.stringify(limitRow)}\n`);
    await r.status("idle");
    const failed = r.store.listRuns("t1").at(-1)!;
    expect(failed.status).toBe("failed");
    expect(items(r).find((i) => i.id === "a1:0")).toMatchObject({ type: "error", failure: { class: "usage_limit", resetAt: 1_800_003_600_000 } });

    r.clock.now += 10_000;
    r.logs.append("s1", claudeRow.user("u2", "again", r.clock.now - 500));
    await r.status("working");
    const interruptRow = {
      type: "user",
      uuid: "x1",
      timestamp: new Date(r.clock.now + 100).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    };
    r.logs.append("s1", `${JSON.stringify(interruptRow)}\n`);
    await r.status("idle");
    const stopped = r.store.listRuns("t1").at(-1)!;
    expect(stopped.status).toBe("interrupted");
    expect(items(r).find((i) => i.id === "x1:0")).toMatchObject({ type: "run_interrupt_result", runId: stopped.id });
    expect(items(r).filter((i) => i.type === "user_message").map((i) => i.id)).toEqual(["u1:0", "u2:0"]);
  });

  test("the newest assistant usage becomes Thread.contextUsage, once per change", async () => {
    const r = rig();
    const usageRow = (uuid: string, ms: number, input: number) =>
      `${JSON.stringify({
        type: "assistant",
        uuid,
        timestamp: new Date(ms).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: input, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 10 },
        },
      })}\n`;
    r.logs.write("s1", claudeRow.user("u1", "hi", T0 - 1_000) + usageRow("a1", T0 - 900, 5));
    await r.ingestor.catchUp("t1");
    expect(r.store.getThread("t1")!.contextUsage).toEqual({ usedTokens: 1015, inputTokens: 1005, cachedInputTokens: 1000, outputTokens: 10 });
    const seq = r.store.lastSequence();
    await r.ingestor.catchUp("t1");
    expect(r.store.lastSequence()).toBe(seq);
    r.logs.append("s1", usageRow("a2", T0 - 800, 50));
    await r.ingestor.catchUp("t1");
    expect(r.store.getThread("t1")!.contextUsage?.usedTokens).toBe(1060);
  });

  test("archive interrupts the open run, and so does a run T06 marked", async () => {
    const r = rig();
    r.logs.write("s1", "");
    await r.ingestor.catchUp("t1");
    await r.status("working");
    const first = r.store.openRun("t1")!;
    r.ingestor.markInterrupted(first.id);
    await r.status("idle");
    expect(r.store.getRun(first.id)!.status).toBe("interrupted");

    await r.status("working");
    const second = r.store.openRun("t1")!;
    r.store.append([{ type: "thread.archived", threadId: "t1", payload: { reason: "user", at: r.clock.now } }]);
    await settle(r);
    expect(r.store.getRun(second.id)!.status).toBe("interrupted");
    expect(r.store.openRun("t1")).toBeNull();
  });

  test("a tool call still running when the run ends is closed with it", async () => {
    const r = rig();
    r.logs.write("s1", "");
    await r.ingestor.catchUp("t1");
    r.logs.append("s1", claudeRow.user("u1", "go", T0) + claudeRow.toolUse("a1", "toolu_1", "Bash", { command: "sleep" }, T0 + 1));
    await r.status("working");
    expect(items(r).find((i) => i.id === "a1:0")!.status).toBe("running");
    await r.status("idle");
    expect(items(r).find((i) => i.id === "a1:0")!.status).toBe("completed");
  });

  test("backfill builds one run per user message on the first ingest", async () => {
    const r = rig();
    r.logs.write(
      "s1",
      claudeRow.assistant("a0", "before anything", T0 - 9_000) +
        claudeRow.user("u1", "one", T0 - 8_000) +
        claudeRow.assistant("a1", "1", T0 - 7_000) +
        claudeRow.user("u2", "two", T0 - 6_000) +
        claudeRow.assistant("a2", "2", T0 - 5_000) +
        claudeRow.user("u3", "three", T0 - 4_000) +
        claudeRow.assistant("a3", "3", T0 - 3_000),
    );
    await r.ingestor.catchUp("t1");
    const runs = r.store.listRuns("t1");
    expect(runs.map((x) => [x.ordinal, x.status, x.userItemId, x.startedAt, x.completedAt])).toEqual([
      [1, "completed", "u1:0", T0 - 8_000, T0 - 7_000],
      [2, "completed", "u2:0", T0 - 6_000, T0 - 5_000],
      [3, "completed", "u3:0", T0 - 4_000, T0 - 3_000],
    ]);
    expect(items(r).map((i) => [i.id, i.runId])).toEqual([
      ["a0:0", null],
      ["u1:0", runs[0]!.id],
      ["a1:0", runs[0]!.id],
      ["u2:0", runs[1]!.id],
      ["a2:0", runs[1]!.id],
      ["u3:0", runs[2]!.id],
      ["a3:0", runs[2]!.id],
    ]);
  });

  test("backfill keeps only the newest entries, and leaves the last run open while working", async () => {
    const r = rig({ threadOver: { status: "working" } });
    let log = "";
    for (let i = 0; i < 40; i++) log += claudeRow.user(`u${i}`, `q${i}`, T0 + i * 10) + claudeRow.assistant(`a${i}`, `r${i}`, T0 + i * 10 + 5);
    r.logs.write("s1", log);
    await r.ingestor.catchUp("t1");
    expect(items(r)).toHaveLength(50);
    expect(itemIds(r)[0]).toBe("u15:0");
    const runs = r.store.listRuns("t1");
    expect(runs).toHaveLength(25);
    expect(runs.at(-1)!.status).toBe("running");
    expect(runs.slice(0, -1).every((x) => x.status === "completed")).toBe(true);
  });
});

describe("journal ingest: Codex rollouts (T16)", () => {
  // Conformance for the Codex adapter: its fixtures ingest to the same item ids whether the log is read
  // in one pass or arrives in two, split at any line.
  for (const name of ["codex-basic.jsonl", "codex-paginated.jsonl"]) {
    test(`${name}: the same item ids however the log is split`, async () => {
      const text = readFileSync(join(import.meta.dir, "..", "journal", "fixtures", name), "utf8");
      const expected = parseCodexTranscript(text).flatMap(entryItemIds).sort();
      const starts = [...text.matchAll(/\n/g)].map((m) => m.index! + 1).filter((at) => at < text.length);
      for (const cut of [0, ...starts.filter((_, i) => i % 3 === 1)]) {
        const r = rig({ parse: parseCodexTranscript });
        r.logs.write("s1", text.slice(0, cut));
        await r.ingestor.catchUp("t1");
        r.logs.append("s1", text.slice(cut));
        await r.ingestor.catchUp("t1");
        const ids = itemIds(r).filter((id) => !id.startsWith("screen:") && !id.startsWith("session:"));
        expect(ids.sort()).toEqual(expected);
        expect(new Set(ids).size).toBe(ids.length);
        r.ingestor.stop();
      }
    });
  }
});

describe("journal ingest: session divider", () => {
  test("a ref change appends one session item, resets the offset and keeps the old order", async () => {
    const r = rig();
    r.logs.write("s1", claudeRow.user("u1", "first session", T0) + claudeRow.assistant("a1", "ok", T0 + 1));
    await r.ingestor.catchUp("t1");
    const before = items(r).map((i) => [i.id, i.ordinal]);

    r.logs.write("s2", claudeRow.user("v1", "after /clear", T0 + 10) + claudeRow.assistant("b1", "fresh", T0 + 11));
    r.pane.agentSession = { kind: "id", value: "s2" };
    r.clock.now += 10_000; // past the cached ref
    await r.ingestor.catchUp("t1");

    const after = items(r);
    expect(after.slice(0, 2).map((i) => [i.id, i.ordinal])).toEqual(before);
    expect(after.slice(2).map((i) => i.id)).toEqual(["session:s2", "v1:0", "b1:0"]);
    expect(after[2]).toMatchObject({ type: "session", from: "s1", to: "s2" });
    const offset = r.store.offsets.get("t1")!;
    expect(offset).toMatchObject({ sessionKey: "id:s2", path: r.logs.pathOf("s2") });
    expect(offset.offset).toBe(new TextEncoder().encode(r.logs.text("s2")).length);

    // The same bytes again: nothing.
    const seq = r.store.lastSequence();
    await r.ingestor.catchUp("t1");
    expect(r.store.lastSequence()).toBe(seq);
  });

  test("a Claude log that continues the same conversation draws no divider and adds only what is new", async () => {
    const r = rig();
    const lineage = claudeRow.user("root", "start", T0) + claudeRow.assistant("a1", "ok", T0 + 1);
    r.logs.write("s1", lineage);
    await r.ingestor.catchUp("t1");
    // Resume copies the lineage into a new file and continues there.
    r.logs.write("s2", lineage + claudeRow.user("u2", "continue", T0 + 20));
    r.pane.agentSession = { kind: "id", value: "s2" };
    r.clock.now += 10_000;
    await r.ingestor.catchUp("t1");
    expect(itemIds(r)).toEqual(["root:0", "a1:0", "u2:0"]);
  });
});

describe("journal ingest: scheduling", () => {
  test("an idle unwatched thread is never read; a watcher starts a catch-up", async () => {
    const r = rig();
    r.logs.write("s1", claudeRow.user("u1", "hello", T0));
    await settle(r);
    // start() ran its resume pass (no saved offsets → no read); the status change below is not work.
    await r.status("done");
    expect(r.logs.calls.resolve).toBe(0);
    r.watchers.add("t1");
    await settle(r);
    expect(r.logs.calls.resolve).toBeGreaterThan(0);
    expect(itemIds(r)).toEqual(["u1:0"]);
  });

  test("the poll reads a working thread every tick and leaves an idle one alone", async () => {
    const r = rig({ pollMs: 5 });
    r.logs.write("s1", claudeRow.user("u1", "hello", T0));
    await Bun.sleep(40);
    await settle(r);
    expect(r.logs.calls.resolve).toBe(0);
    await r.status("working");
    const afterStart = r.logs.calls.stat;
    r.logs.append("s1", claudeRow.assistant("a1", "streaming in", T0 + 1));
    await Bun.sleep(40);
    await settle(r);
    expect(r.logs.calls.stat).toBeGreaterThan(afterStart + 1);
    expect(itemIds(r)).toEqual(["u1:0", "a1:0"]);
  });

  test("a restart with saved offsets resumes without re-emitting", async () => {
    const r = rig();
    r.logs.write("s1", claudeRow.user("u1", "hello", T0) + claudeRow.assistant("a1", "hi", T0 + 1));
    await r.ingestor.catchUp("t1");
    const seq = r.store.lastSequence();
    r.logs.append("s1", claudeRow.assistant("a2", "while down", T0 + 2));

    const again = r.restart();
    await settle(again);
    const events = again.store.storedEventsAfter(seq);
    expect(events.map((e) => (e.type === "turn-item.updated" ? e.payload.item.id : e.type))).toEqual(["a2:0"]);
  });
});

describe("journal ingest: screen items and failure", () => {
  test("a no-journal thread's run end reads the visible screen once and emits one capped item", async () => {
    const big = Array.from({ length: 400 }, (_, i) => `row ${i} ${"#".repeat(40)}`).join("\n") + "\n\n\n";
    const r = rig({ harness: "agy", screen: big });
    await r.status("working");
    const run = r.store.openRun("t1")!;
    await r.status("idle");
    expect(r.readCalls).toEqual([{ paneId: PANE, source: "visible", lines: 60, format: "text" }]);
    const screen = items(r).filter((i) => i.type === "screen");
    expect(screen).toHaveLength(1);
    expect(screen[0]).toMatchObject({ id: `screen:${run.id}`, runId: run.id, capturedAt: r.clock.now });
    const text = (screen[0] as Extract<TurnItem, { type: "screen" }>).text;
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(SCREEN_MAX_BYTES);
    expect(text.endsWith(`row 399 ${"#".repeat(40)}`)).toBe(true);
    expect(r.logs.calls.resolve).toBe(0);
  });

  test("screenText strips trailing blank lines", () => {
    expect(screenText("a\nb\n\n   \n")).toBe("a\nb");
  });

  test("a throwing adapter produces no events and one warning per thread per 10 minutes", async () => {
    const r = rig({
      parse: () => {
        throw new Error("bad grammar");
      },
    });
    r.logs.write("s1", claudeRow.user("u1", "x", T0));
    const seq = r.store.lastSequence();
    await r.ingestor.catchUp("t1");
    r.logs.append("s1", claudeRow.user("u2", "y", T0 + 1));
    await r.ingestor.catchUp("t1");
    expect(r.store.lastSequence()).toBe(seq);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("bad grammar");
    r.clock.now += 11 * 60_000;
    await r.ingestor.catchUp("t1");
    expect(r.warnings).toHaveLength(2);
  });

  test("a missing log produces no events and a warning", async () => {
    const r = rig();
    const seq = r.store.lastSequence();
    await r.ingestor.catchUp("t1");
    expect(r.store.lastSequence()).toBe(seq);
    expect(r.warnings).toHaveLength(1);
  });
});
