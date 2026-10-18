import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEARCH_EXCERPT_CHARS, SEARCH_MAX_LIMIT } from "../../shared/v2/contracts.ts";
import { createProject, createThread, project, textItem, thread } from "../test/thread-fixtures.ts";
import type { EventDraft, TurnItemDraft } from "./events.ts";
import { clampSearchLimit, excerptFor, matchExpression, MAX_PER_THREAD, queryTokens } from "./search.ts";
import { MIGRATIONS, openThreadStore, RETAIN_ARCHIVED_MS, type ThreadStore } from "./store.ts";

const stores: ThreadStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(path = ":memory:", now = () => 1_000_000): ThreadStore {
  const store = openThreadStore(path, { now, log: () => {} });
  stores.push(store);
  return store;
}

const upsert = (threadId: string, item: TurnItemDraft): EventDraft => ({ type: "turn-item.updated", threadId, payload: { item } });
const assistant = (id: string, threadId: string, text: string, over: Partial<TurnItemDraft> = {}): EventDraft =>
  upsert(threadId, { ...textItem(id, threadId, null, text), ...over } as TurnItemDraft);
const user = (id: string, threadId: string, text: string): EventDraft =>
  upsert(threadId, { ...textItem(id, threadId, null, text), type: "user_message", attachments: [] } as unknown as TurnItemDraft);
const command = (id: string, threadId: string, input: string, output = ""): EventDraft =>
  upsert(threadId, { ...textItem(id, threadId), type: "command_execution", input, output } as unknown as TurnItemDraft);
const other = (id: string, threadId: string, type: string, text: string): EventDraft =>
  upsert(threadId, { ...textItem(id, threadId), type, text } as unknown as TurnItemDraft);

function seeded(): ThreadStore {
  const store = open();
  store.append([
    createProject(project("w1", { label: "alpha" })),
    createThread(thread("t1", { title: "Fix the parser" })),
    createThread(thread("t2", { paneId: "w1:p-t2", terminalId: "term-t2", title: "Deploy notes" })),
  ]);
  return store;
}

describe("query building", () => {
  test("words become quoted prefix terms, operators and punctuation are neutered", () => {
    expect(queryTokens('foo "bar" AND (baz*) -qux')).toEqual(["foo", "bar", "AND", "baz", "qux"]);
    expect(matchExpression(queryTokens('say "hi" now'))).toBe('"say"* AND "hi"* AND "now"*');
    expect(queryTokens("a b c d e f g h")).toHaveLength(6);
    expect(matchExpression(queryTokens("!!! ---"))).toBeNull();
    expect(queryTokens("x".repeat(500))[0]).toHaveLength(64);
  });

  test("limit clamps into 1..50 with a default", () => {
    expect(clampSearchLimit(undefined)).toBe(20);
    expect(clampSearchLimit(0)).toBe(20);
    expect(clampSearchLimit(-5)).toBe(20);
    expect(clampSearchLimit(1.5)).toBe(20);
    expect(clampSearchLimit(7)).toBe(7);
    expect(clampSearchLimit(5000)).toBe(SEARCH_MAX_LIMIT);
  });
});

describe("excerptFor", () => {
  test("a short text comes back whole with the hit marked", () => {
    const { excerpt, ranges } = excerptFor("Please fix the parser bug", ["parser"]);
    expect(excerpt).toBe("Please fix the parser bug");
    expect(ranges).toEqual([{ start: 15, end: 21 }]);
  });

  test("a long text is cut around the first hit, at most 160 characters, ranges inside the cut", () => {
    const text = `${"lorem ipsum dolor ".repeat(40)}needle in the middle ${"sit amet ".repeat(40)}`;
    const { excerpt, ranges } = excerptFor(text, ["needle"]);
    expect(excerpt.length).toBeLessThanOrEqual(SEARCH_EXCERPT_CHARS);
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(ranges).toHaveLength(1);
    expect(excerpt.slice(ranges[0]!.start, ranges[0]!.end)).toBe("needle");
  });

  test("whitespace and newlines collapse, matching ignores case and marks prefixes only at a word start", () => {
    const { excerpt, ranges } = excerptFor("Line one\n\n   NEEDLE here and unneedled", ["needle"]);
    expect(excerpt).toBe("Line one NEEDLE here and unneedled");
    expect(ranges.map((r) => excerpt.slice(r.start, r.end))).toEqual(["NEEDLE"]);
  });
});

describe("the index", () => {
  test("finds user and assistant text and command inputs, with a role, and skips output and other items", () => {
    const store = seeded();
    store.append([
      user("u1", "t1", "Why does the zebra crash?"),
      assistant("a1", "t1", "The zebra handler dereferences null."),
      command("c1", "t1", "grep -rn zebra src/", "src/zebra.ts:4: matched zebra"),
      command("c2", "t1", "ls", "only-in-output-quokka"),
      other("r1", "t1", "reasoning", "thinking about zebra"),
      other("n1", "t1", "system_notice", "notice zebra"),
    ]);
    const res = store.search({ q: "zebra" });
    expect(res.results.map((r) => [r.itemId, r.role]).sort()).toEqual([
      ["a1", "assistant"],
      ["c1", "tool"],
      ["u1", "user"],
    ]);
    const hit = res.results.find((r) => r.itemId === "u1")!;
    expect(hit).toMatchObject({ threadId: "t1", threadTitle: "Fix the parser", projectId: "w1", projectLabel: "alpha", archived: false, at: 1_000 });
    expect(hit.excerpt.slice(hit.ranges[0]!.start, hit.ranges[0]!.end)).toBe("zebra");
    expect(store.search({ q: "quokka" }).results).toEqual([]);
    expect(store.search({ q: "thinking" }).results).toEqual([]);
  });

  test("matches word prefixes, all words required, newest first", () => {
    const store = seeded();
    store.append([assistant("a1", "t1", "refactoring the parser"), assistant("a2", "t2", "parser tests pass"), assistant("a3", "t2", "unrelated")]);
    expect(store.search({ q: "refac pars" }).results.map((r) => r.itemId)).toEqual(["a1"]);
    expect(store.search({ q: "parser" }).results.map((r) => r.itemId)).toEqual(["a2", "a1"]);
    expect(store.search({ q: "arser" }).results).toEqual([]);
  });

  test("odd queries answer no results instead of failing", () => {
    const store = seeded();
    store.append([assistant("a1", "t1", "hello world")]);
    for (const q of ['"', "AND", "NEAR(", "hel*", "'; DROP TABLE turn_items; --", "   ", "h", "!!"]) {
      expect(() => store.search({ q })).not.toThrow();
    }
    expect(store.search({ q: "h" }).results).toEqual([]);
    expect(store.search({ q: "hel*" }).results).toHaveLength(1);
    expect(store.search({ q: "wor\"ld" }).results).toHaveLength(0);
  });

  test("an item rewritten in place is re-indexed (streaming), and the old words stop matching", () => {
    const store = seeded();
    store.append([assistant("a1", "t1", "partial answer about giraffes", { streaming: true } as never)]);
    expect(store.search({ q: "giraffes" }).results).toHaveLength(1);
    store.append([assistant("a1", "t1", "final answer about okapis")]);
    expect(store.search({ q: "giraffes" }).results).toEqual([]);
    expect(store.search({ q: "okapis" }).results.map((r) => r.itemId)).toEqual(["a1"]);
    expect(store.getTurnItem("a1")?.ordinal).toBe(0);
  });

  test("an item that stops being searchable drops out", () => {
    const store = seeded();
    store.append([assistant("x1", "t1", "marmot habitat")]);
    expect(store.search({ q: "marmot" }).results).toHaveLength(1);
    store.append([other("x1", "t1", "reasoning", "marmot habitat")]);
    expect(store.search({ q: "marmot" }).results).toEqual([]);
  });

  test("archived threads are left out unless asked for", () => {
    const store = seeded();
    store.append([assistant("a1", "t1", "ocelot sighting"), assistant("a2", "t2", "ocelot report")]);
    store.append([{ type: "thread.archived", threadId: "t2", payload: { reason: "user", at: 5 } }]);
    expect(store.getThread("t2")?.shelf).toBe("archived");
    expect(store.search({ q: "ocelot" }).results.map((r) => r.itemId)).toEqual(["a1"]);
    const all = store.search({ q: "ocelot", includeArchived: true }).results;
    expect(all.map((r) => [r.itemId, r.archived])).toEqual([
      ["a2", true],
      ["a1", false],
    ]);
  });

  test("limit caps the list and one thread cannot fill it", () => {
    const store = seeded();
    const drafts: EventDraft[] = [];
    for (let i = 0; i < 10; i++) drafts.push(assistant(`m${i}`, "t1", `lemur number ${i}`));
    drafts.push(assistant("z1", "t2", "lemur elsewhere"));
    store.append(drafts);
    const res = store.search({ q: "lemur", limit: 50 });
    expect(res.results.filter((r) => r.threadId === "t1")).toHaveLength(MAX_PER_THREAD);
    expect(res.results.some((r) => r.threadId === "t2")).toBe(true);
    expect(res.truncated).toBe(true);
    expect(store.search({ q: "lemur", limit: 2 }).results).toHaveLength(2);
    expect(store.search({ q: "lemur", limit: 9999 }).results.length).toBeLessThanOrEqual(SEARCH_MAX_LIMIT);
  });

  test("excerpts never exceed 160 characters even for a huge message", () => {
    const store = seeded();
    store.append([assistant("a1", "t1", `${"x ".repeat(5_000)} tapir ${"y ".repeat(30_000)}`)]);
    const [hit] = store.search({ q: "tapir" }).results;
    expect(hit).toBeDefined();
    expect(hit!.excerpt.length).toBeLessThanOrEqual(SEARCH_EXCERPT_CHARS);
  });

  test("prune drops the index rows of pruned items and of a deleted archived thread", () => {
    const store = seeded();
    store.append([assistant("a1", "t2", "wombat burrow")]);
    store.append([{ type: "thread.archived", threadId: "t2", payload: { reason: "user", at: 5 } }]);
    expect(store.search({ q: "wombat", includeArchived: true }).results).toHaveLength(1);
    const result = store.prune(5 + RETAIN_ARCHIVED_MS + 1);
    expect(result.threads).toBeGreaterThanOrEqual(1);
    expect(store.getThread("t2")).toBeNull();
    expect(store.search({ q: "wombat", includeArchived: true }).results).toEqual([]);
  });
});

describe("migration 6", () => {
  test("indexes the rows a version-5 database already holds", () => {
    const dir = mkdtempSync(join(tmpdir(), "sightr-search-"));
    dirs.push(dir);
    const path = join(dir, "threads.sqlite");
    const old = new Database(path);
    old.run(`CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
    for (const m of MIGRATIONS.filter((x) => x.version <= 5)) {
      m.up(old);
      old.query("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
    }
    old.run("PRAGMA user_version = 5");
    old.run(`INSERT INTO projects (id, label, label_source, number, ord, status) VALUES ('w1', 'alpha', 'herd', 1, 1, 'idle')`);
    old.run(
      `INSERT INTO threads (id, pane_id, terminal_id, project_id, title, title_source, harness, status, shelf, unread_done, last_activity_at, created_at, updated_at, capabilities_json)
       VALUES ('t1', 'p', 'tm', 'w1', 'Old thread', 'herd', 'claude', 'idle', 'active', 0, 1, 1, 1, '{}')`,
    );
    const ins = old.query(`INSERT INTO turn_items (id, thread_id, run_id, position, type, body_json, updated_sequence) VALUES (?, 't1', NULL, ?, ?, ?, ?)`);
    ins.run("i1", 0, "user_message", JSON.stringify({ id: "i1", type: "user_message", text: "legacy pangolin question", createdAt: 77 }), 1);
    ins.run("i2", 1, "command_execution", JSON.stringify({ id: "i2", type: "command_execution", input: "cat pangolin.md", output: "zzz" }), 2);
    ins.run("i3", 2, "reasoning", JSON.stringify({ id: "i3", type: "reasoning", text: "pangolin thoughts" }), 3);
    old.close();

    const store = open(path);
    const res = store.search({ q: "pangolin" });
    expect(res.results.map((r) => [r.itemId, r.role]).sort()).toEqual([
      ["i1", "user"],
      ["i2", "tool"],
    ]);
    expect(res.results.find((r) => r.itemId === "i1")?.at).toBe(77);
    // The triggers are live on the migrated database too.
    store.append([assistant("a9", "t1", "a fresh pangolin note")]);
    expect(store.search({ q: "fresh" }).results.map((r) => r.itemId)).toEqual(["a9"]);
  });
});
