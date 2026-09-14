import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAIM_LIVE,
  CLAIM_REPORTED,
  CLAIM_TITLE,
  CLAIM_WEAK,
  ClaimStore,
  coerceClaims,
} from "./claims.ts";

const AGENT = "grok";
const CWD = "c:/work-dir";
const A = "session-a";
const B = "session-b";

async function tempFile(): Promise<{ dir: string; file: string }> {
  const dir = join(tmpdir(), `sightr-claims-${Math.floor(performance.now() * 1000)}`);
  await mkdir(dir, { recursive: true });
  return { dir, file: join(dir, "pane-claims.json") };
}

describe("ClaimStore — exclusivity", () => {
  test("one session is held by one pane at a time", async () => {
    const store = new ClaimStore(null);
    await store.ready();
    expect(store.set(AGENT, CWD, "p1", A, CLAIM_LIVE)).toBe(true);
    expect(store.set(AGENT, CWD, "p2", A, CLAIM_LIVE)).toBe(true);
    expect(store.claimOf(AGENT, CWD, "p1")).toBeUndefined();
    expect(store.claimOf(AGENT, CWD, "p2")?.sessionId).toBe(A);
  });

  test("weaker evidence cannot displace a stronger claim", async () => {
    const store = new ClaimStore(null);
    await store.ready();
    store.set(AGENT, CWD, "p1", A, CLAIM_LIVE);
    // A positional guess must not take a log off a pane that was identified from its own screen.
    expect(store.set(AGENT, CWD, "p2", A, CLAIM_WEAK)).toBe(false);
    expect(store.claimOf(AGENT, CWD, "p1")?.sessionId).toBe(A);
    expect(store.claimOf(AGENT, CWD, "p2")).toBeUndefined();
  });

  test("equal evidence does displace — it is the more recent observation", async () => {
    const store = new ClaimStore(null);
    await store.ready();
    store.set(AGENT, CWD, "p1", A, CLAIM_TITLE);
    expect(store.set(AGENT, CWD, "p2", A, CLAIM_TITLE)).toBe(true);
    expect(store.claimOf(AGENT, CWD, "p1")).toBeUndefined();
  });

  test("a pane moving to another session frees the one it held", async () => {
    const store = new ClaimStore(null);
    await store.ready();
    store.set(AGENT, CWD, "p1", A, CLAIM_LIVE);
    store.set(AGENT, CWD, "p1", B, CLAIM_LIVE);
    expect(store.ownerOf(AGENT, CWD, A)).toBeUndefined();
    expect(store.ownerOf(AGENT, CWD, B)?.paneId).toBe("p1");
  });

  test("groups are independent — same pane id, different agent or cwd", async () => {
    const store = new ClaimStore(null);
    await store.ready();
    store.set(AGENT, CWD, "p1", A, CLAIM_LIVE);
    expect(store.set("pi", CWD, "p1", A, CLAIM_LIVE)).toBe(true);
    expect(store.set(AGENT, "c:/other", "p1", A, CLAIM_LIVE)).toBe(true);
    expect(store.claimOf(AGENT, CWD, "p1")?.sessionId).toBe(A);
  });
});

describe("ClaimStore — a pane's own answer is never downgraded", () => {
  test("a weaker signal cannot move a pane off the log its screen proved", async () => {
    const store = new ClaimStore(null);
    await store.ready();
    store.set(AGENT, CWD, "p1", A, CLAIM_LIVE);
    // This is the stale-reported-id case: Herdr still names the pane's previous session.
    expect(store.set(AGENT, CWD, "p1", B, CLAIM_REPORTED)).toBe(false);
    expect(store.claimOf(AGENT, CWD, "p1")?.sessionId).toBe(A);
  });

  test("equal or stronger evidence does move the pane", async () => {
    const store = new ClaimStore(null);
    await store.ready();
    store.set(AGENT, CWD, "p1", A, CLAIM_REPORTED);
    expect(store.set(AGENT, CWD, "p1", B, CLAIM_TITLE)).toBe(true);
    expect(store.claimOf(AGENT, CWD, "p1")?.sessionId).toBe(B);
  });

  test("re-confirming the same log at lower strength is allowed", async () => {
    const store = new ClaimStore(null);
    await store.ready();
    store.set(AGENT, CWD, "p1", A, CLAIM_LIVE);
    expect(store.set(AGENT, CWD, "p1", A, CLAIM_WEAK)).toBe(true);
  });

  test("the reported id sits between a guess and the terminal title", () => {
    expect(CLAIM_WEAK).toBeLessThan(CLAIM_REPORTED);
    expect(CLAIM_REPORTED).toBeLessThan(CLAIM_TITLE);
    expect(CLAIM_TITLE).toBeLessThan(CLAIM_LIVE);
  });
});

describe("ClaimStore — pruning", () => {
  test("a deleted session stops reserving a slot", async () => {
    const store = new ClaimStore(null);
    await store.ready();
    store.set(AGENT, CWD, "p1", A, CLAIM_LIVE);
    store.dropMissingSessions(AGENT, CWD, new Set([B]));
    expect(store.claimOf(AGENT, CWD, "p1")).toBeUndefined();
  });

  test("a pane that no longer runs this agent here gives its session back", async () => {
    const store = new ClaimStore(null);
    await store.ready();
    store.set(AGENT, CWD, "p1", A, CLAIM_LIVE);
    store.set(AGENT, CWD, "p2", B, CLAIM_LIVE);
    store.keepOnlyPanes(AGENT, CWD, new Set(["p2"]));
    expect(store.ownerOf(AGENT, CWD, A)).toBeUndefined();
    expect(store.ownerOf(AGENT, CWD, B)?.paneId).toBe("p2");
  });

  test("pruning one group leaves another group alone", async () => {
    const store = new ClaimStore(null);
    await store.ready();
    store.set(AGENT, CWD, "p1", A, CLAIM_LIVE);
    store.set(AGENT, "c:/other", "p9", B, CLAIM_LIVE);
    store.keepOnlyPanes(AGENT, CWD, new Set());
    expect(store.claimOf(AGENT, "c:/other", "p9")?.sessionId).toBe(B);
  });
});

describe("ClaimStore — durability", () => {
  test("claims survive a restart", async () => {
    const { dir, file } = await tempFile();
    const first = new ClaimStore(file);
    await first.ready();
    first.set(AGENT, CWD, "p1", A, CLAIM_LIVE);
    first.set(AGENT, CWD, "p2", B, CLAIM_TITLE);
    await first.flush();

    const second = new ClaimStore(file);
    await second.ready();
    expect(second.claimOf(AGENT, CWD, "p1")?.sessionId).toBe(A);
    expect(second.claimOf(AGENT, CWD, "p2")?.strength).toBe(CLAIM_TITLE);
    await rm(dir, { recursive: true, force: true });
  });

  test("a missing file is simply no claims, not an error", async () => {
    const { dir, file } = await tempFile();
    const store = new ClaimStore(file);
    await store.ready();
    expect(store.all()).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  test("a corrupt file degrades to no claims", async () => {
    const { dir, file } = await tempFile();
    await Bun.write(file, "{not json");
    const store = new ClaimStore(file);
    await store.ready();
    expect(store.all()).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("coerceClaims", () => {
  test("keeps well-formed rows and drops the rest", () => {
    const rows = coerceClaims({
      version: 1,
      claims: [
        { agent: "grok", cwd: "c:/x", paneId: "p1", sessionId: "s1", strength: 3, at: 1 },
        { agent: "grok", cwd: "c:/x", paneId: "p2", sessionId: "s2", strength: 9, at: 1 },
        { agent: "grok", cwd: "c:/x", paneId: "p3", at: 1 },
        null,
        "nope",
      ],
    });
    expect(rows.map((r) => r.paneId)).toEqual(["p1"]);
  });

  test("anything that is not a claims array is no claims", () => {
    expect(coerceClaims(null)).toEqual([]);
    expect(coerceClaims({ claims: "no" })).toEqual([]);
    expect(coerceClaims([])).toEqual([]);
  });
});
