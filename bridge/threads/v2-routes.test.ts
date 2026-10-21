import { afterEach, describe, expect, test } from "bun:test";

import type { RuntimeRequest, ThreadEvent } from "../../shared/v2/contracts.ts";
import { SEEN_HEADER } from "../../shared/limits.ts";
import type { AuditEntry, AuditLog } from "../audit.ts";
import type { Config } from "../config.ts";
import type { LockStore } from "../lock.ts";
import { lockGate } from "../lock-routes.ts";
import { createPaneQueue, PaneBusyError, type PaneQueue } from "../pane-queue.ts";
import type { EngineSnapshot } from "../state-engine.ts";
import { createProject, createThread, textItem, thread } from "../test/thread-fixtures.ts";
import type { EventDraft } from "./events.ts";
import { createV2Gate, type V2Gate } from "./herdr-floor.ts";
import { createThreadWatchers } from "./journal-ingest.ts";
import type { RespondHandler, RespondResult } from "./respond.ts";
import { encodeHistoryCursor, openThreadStore, SNAPSHOT_RUNS, type ThreadStore } from "./store.ts";
import {
  commandHash,
  createV2Routes,
  respondEffect,
  resumeCursor,
  type EffectRegistry,
  type V2Routes,
  type V2RoutesDeps,
} from "./v2-routes.ts";

// ── Rig ──────────────────────────────────────────────────────────────────────────────────────────

function cfg(over: Partial<Config> = {}): Config {
  return {
    allowAnyHost: true,
    allowedOrigins: [],
    publicHosts: [],
    tailscaleHosts: [],
    trustedUser: "",
    trustedUserOptional: false,
    skipServe: false,
    deviceHeader: "",
    deviceAllowlist: [],
    notifyDelayMs: 30_000,
    submitKeys: ["Enter"],
    readLines: 200,
    ...over,
  } as unknown as Config;
}

async function okGate(): Promise<V2Gate> {
  const gate = createV2Gate({ log: () => {} });
  await gate.check({ serverVersion: async () => "0.9.0" });
  return gate;
}

interface Rig {
  store: ThreadStore;
  routes: V2Routes;
  clock: { t: number };
  tick(): void;
  queueKeys: string[];
  seen: string[];
  unseen: string[];
  reconciles: number;
  audits: AuditEntry[];
  watchers: ReturnType<typeof createThreadWatchers>;
  conn: { kind: string; sid?: string; why?: string }[];
}

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) {
    r.routes.close();
    try {
      r.store.close();
    } catch {
      // shared with another rig
    }
  }
});

async function rig(over: Partial<V2RoutesDeps> & { live?: boolean; queue?: PaneQueue } = {}): Promise<Rig> {
  const clock = { t: 1_000_000 };
  let n = 0;
  let store: ThreadStore;
  if (over.store) {
    store = over.store;
  } else {
    store = openThreadStore(":memory:", { now: () => clock.t, newId: () => `id${++n}`, log: () => {} });
    store.append([createProject(), createThread(thread("t1")), createThread(thread("t2", { paneId: "w1:p-t2" }))]);
  }
  const tickers: (() => void)[] = [];
  const queueKeys: string[] = [];
  const base = over.queue ?? createPaneQueue();
  const queue: PaneQueue = {
    run: (key, fn) => {
      queueKeys.push(key);
      return base.run(key, fn);
    },
    size: () => base.size(),
  };
  const watchers = createThreadWatchers();
  const audits: AuditEntry[] = [];
  const conn: Rig["conn"] = [];
  const r: Rig = {
    store,
    routes: null as unknown as V2Routes,
    clock,
    tick: () => tickers.forEach((fn) => fn()),
    queueKeys,
    seen: [],
    unseen: [],
    reconciles: 0,
    audits,
    watchers,
    conn,
  };
  const snap = {
    agents: [{ paneId: "w1:p-t1", terminalId: "term-t1" }],
    shellPanes: [{ paneId: "w1:p-t2", terminalId: "term-t2" }],
    workspaces: [],
    tabs: [],
    bridge: "connected",
  } as unknown as EngineSnapshot;
  r.routes = createV2Routes({
    cfg: cfg(),
    store,
    gate: await okGate(),
    engine: { current: () => snap },
    activity: {
      noteSeen: (_s, paneId) => (r.seen.push(paneId), true),
      noteUnseen: (_s, paneId) => (r.unseen.push(paneId), true),
    },
    queue,
    auditFor: () => ({ record: (e: AuditEntry) => audits.push(e) }) as unknown as AuditLog,
    conn: { bridge: (e: { kind: string; sid?: string; why?: string }) => conn.push(e) } as never,
    watchers,
    herdIngestor: { reconcile: () => ((r.reconciles += 1), 0) },
    now: () => clock.t,
    timers: { setInterval: (fn) => (tickers.push(fn), tickers.length), clearInterval: () => {} },
    buildId: async () => "build-1",
    ...over,
  });
  rigs.push(r);
  return r;
}

const URL_BASE = "http://localhost";

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_BASE + path, { headers: { host: "localhost", ...headers } });
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_BASE + "/api/v2/command", {
    method: "POST",
    headers: { "content-type": "application/json", origin: URL_BASE, host: "localhost", ...headers },
    body: JSON.stringify(body),
  });
}

async function call(r: Rig, req: Request): Promise<Response> {
  const res = r.routes.handle(req, new URL(req.url));
  if (!res) throw new Error(`not a v2 route: ${req.url}`);
  return res;
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

interface Frame {
  id?: string;
  event?: string;
  data?: unknown;
  comment?: string;
}

function parseFrames(raw: string): Frame[] {
  return raw
    .split("\n\n")
    .filter((b) => b.trim() !== "")
    .map((block) => {
      const f: Frame = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) f.comment = line.slice(1).trim();
        else if (line.startsWith("id: ")) f.id = line.slice(4);
        else if (line.startsWith("event: ")) f.event = line.slice(7);
        else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
      }
      return f;
    });
}

/** Reads an SSE response as frames. `until` waits (real time, bounded) for a condition. */
function sse(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let done = false;
  let pending: Promise<void> | null = null;
  const pump = (): Promise<void> =>
    (pending ??= reader.read().then(({ value, done: d }) => {
      pending = null;
      if (value) raw += decoder.decode(value, { stream: true });
      if (d) done = true;
    }));
  return {
    get done() {
      return done;
    },
    frames: () => parseFrames(raw.slice(0, raw.lastIndexOf("\n\n") + 2)),
    async until(pred: (frames: Frame[]) => boolean, ms = 1_000): Promise<Frame[]> {
      const end = Date.now() + ms;
      while (!pred(this.frames()) && !done && Date.now() < end) {
        await Promise.race([pump(), new Promise((r) => setTimeout(r, 20))]);
      }
      return this.frames();
    },
    async drain(ms = 1_000): Promise<Frame[]> {
      const end = Date.now() + ms;
      while (!done && Date.now() < end) await Promise.race([pump(), new Promise((r) => setTimeout(r, 20))]);
      return this.frames();
    },
    cancel: () => reader.cancel(),
  };
}

/** A thread snapshot frame's payload, decoding the `gz` envelope the bridge sends (spec 26). */
function snapshotOf(f: Frame | undefined): Record<string, unknown> {
  if (!f) throw new Error("no snapshot frame");
  const data = f.data as { gz?: string };
  if (typeof data?.gz !== "string") return data as Record<string, unknown>;
  const json = new TextDecoder().decode(Bun.gunzipSync(Buffer.from(data.gz, "base64")));
  return JSON.parse(json) as Record<string, unknown>;
}

const named = (frames: Frame[], event: string) => frames.filter((f) => f.event === event);
const synced = (frames: Frame[]) => named(frames, "synchronized").length > 0;
const eventsOf = (frames: Frame[]) => named(frames, "event").map((f) => f.data as ThreadEvent);

function rename(threadId: string, title: string): EventDraft {
  return { type: "thread.updated", threadId, payload: { patch: { title }, at: 1 } };
}

function item(id: string, threadId: string, runId: string | null = null, text?: string): EventDraft {
  return { type: "turn-item.updated", threadId, payload: { item: textItem(id, threadId, runId, text) } };
}

function startRun(id: string, threadId: string, ordinal: number): EventDraft {
  return { type: "run.started", threadId, payload: { run: { id, threadId, ordinal, status: "running", startedAt: ordinal } } };
}

// ── Floor ────────────────────────────────────────────────────────────────────────────────────────

describe("herdr floor and v2 switch", () => {
  const PATHS = ["/api/v2/shell", "/api/v2/thread/t1", "/api/v2/thread/t1/history", "/api/v2/search?q=hello"];

  test("too-old: every v2 route answers 503 herdr-too-old with the reason", async () => {
    const gate = createV2Gate({ log: () => {} });
    await gate.check({ serverVersion: async () => "0.8.9" });
    const r = await rig({ gate });
    for (const path of PATHS) {
      const res = await call(r, get(path));
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toContain("json");
      expect(await body(res)).toEqual({
        ok: false,
        code: "herdr-too-old",
        error: "v2 needs herdr >= 0.9.0 (found 0.8.9)",
        have: "0.8.9",
        need: "0.9.0",
      });
    }
    const cmd = await call(r, post({ commandId: "c1", type: "thread.pin", threadId: "t1" }));
    expect(cmd.status).toBe(503);
    expect((await body(cmd)).code).toBe("herdr-too-old");
    // v1 paths are not v2's: server.ts routes them as before, whatever the gate says.
    expect(r.routes.handle(get("/api/snapshot"), new URL(URL_BASE + "/api/snapshot"))).toBeNull();
    expect(r.routes.handle(get("/api/events"), new URL(URL_BASE + "/api/events"))).toBeNull();
    expect(r.store.lastSequence()).toBe(3);
  });

  test("pending (herdr unreachable at start) answers v2-starting, then serves once the check succeeds", async () => {
    const gate = createV2Gate({ log: () => {} });
    await gate.check({
      serverVersion: async () => {
        throw new Error("connect ENOENT");
      },
    });
    const r = await rig({ gate });
    const res = await call(r, get("/api/v2/shell"));
    expect(res.status).toBe(503);
    expect((await body(res)).code).toBe("v2-starting");
    await gate.check({ serverVersion: async () => "0.9.0" });
    const live = await call(r, get("/api/v2/shell"));
    expect(live.status).toBe(200);
    await sse(live).cancel();
  });

  test("no store (SIGHTR_V2=0) answers v2-disabled", async () => {
    const r = await rig({ store: null });
    const res = await call(r, get("/api/v2/shell"));
    expect(res.status).toBe(503);
    expect((await body(res)).code).toBe("v2-disabled");
  });

  test("an unknown v2 path is not handled (server.ts answers 404)", async () => {
    const r = await rig();
    expect(r.routes.handle(get("/api/v2/nope"), new URL(URL_BASE + "/api/v2/nope"))).toBeNull();
  });
});

// ── Access ───────────────────────────────────────────────────────────────────────────────────────

describe("access", () => {
  test("a read-only device gets 403 on commands and 200 on streams and history", async () => {
    const r = await rig({ cfg: cfg({ deviceHeader: "x-device", deviceAllowlist: ["phone"] }) });
    const cmd = await call(r, post({ commandId: "c1", type: "thread.pin", threadId: "t1" }, { "x-device": "laptop" }));
    expect(cmd.status).toBe(403);
    const shell = await call(r, get("/api/v2/shell", { "x-device": "laptop" }));
    expect(shell.status).toBe(200);
    await sse(shell).cancel();
    const thread = await call(r, get("/api/v2/thread/t1", { "x-device": "laptop" }));
    expect(thread.status).toBe(200);
    await sse(thread).cancel();
    expect((await call(r, get("/api/v2/thread/t1/history", { "x-device": "laptop" }))).status).toBe(200);
    const ok = await call(r, post({ commandId: "c1", type: "thread.pin", threadId: "t1" }, { "x-device": "phone" }));
    expect(ok.status).toBe(200);
  });

  test("the shell snapshot tells a device whether it is read-only (T12)", async () => {
    const r = await rig({ cfg: cfg({ deviceHeader: "x-device", deviceAllowlist: ["phone"] }) });
    for (const [device, authorized] of [["laptop", false], ["phone", true]] as const) {
      const s = sse(await call(r, get("/api/v2/shell", { "x-device": device })));
      const frames = await s.until((f) => f.some((x) => x.event === "synchronized"));
      const snap = frames.find((f) => f.event === "snapshot")!.data as { device?: { enforced: boolean; device: string; authorized: boolean } };
      expect(snap.device).toEqual({ enforced: true, device, authorized });
      await s.cancel();
    }
  });

  test("a cross-origin request is refused on every route", async () => {
    const r = await rig();
    const evil = { origin: "https://evil.example", host: "localhost" };
    expect((await call(r, get("/api/v2/shell", evil))).status).toBe(403);
    expect((await call(r, post({ commandId: "c1", type: "thread.pin", threadId: "t1" }, evil))).status).toBe(403);
  });

  test("the lock gate covers /api/v2/*", () => {
    const lock = { enabled: () => true, valid: () => false } as unknown as LockStore;
    for (const path of ["/api/v2/shell", "/api/v2/command", "/api/v2/thread/t1"]) {
      const res = lockGate(get(path), new URL(URL_BASE + path), cfg(), lock);
      expect(res?.status).toBe(401);
    }
  });
});

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────

describe("POST /api/v2/command", () => {
  test("a pure command commits and returns its sequence; the same id again returns the same reply", async () => {
    const r = await rig();
    const cmd = { commandId: "c-1", type: "thread.rename", threadId: "t1", title: "Renamed" };
    const first = await call(r, post(cmd));
    expect(first.status).toBe(200);
    const reply = await body(first);
    expect(reply).toEqual({ ok: true, sequence: 4 });
    expect(r.store.getThread("t1")?.title).toBe("Renamed");
    // Key order does not matter for the body hash.
    const again = await call(r, post({ title: "Renamed", threadId: "t1", type: "thread.rename", commandId: "c-1" }));
    expect(again.status).toBe(200);
    expect(await body(again)).toEqual(reply);
    expect(r.store.lastSequence()).toBe(4);
    expect(r.audits).toEqual([{ action: "v2-command", paneId: "w1:p-t1", detail: { type: "thread.rename", threadId: "t1" } }]);
  });

  test("the same id with a different body is a 409 conflict", async () => {
    const r = await rig();
    await call(r, post({ commandId: "c-1", type: "thread.rename", threadId: "t1", title: "A" }));
    const res = await call(r, post({ commandId: "c-1", type: "thread.rename", threadId: "t1", title: "B" }));
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe("conflict");
    const other = await call(r, post({ commandId: "c-1", type: "thread.pin", threadId: "t1" }));
    expect(other.status).toBe(409);
    expect(r.store.getThread("t1")?.title).toBe("A");
  });

  test("a no-op command answers ok with the current sequence and writes no event", async () => {
    const r = await rig();
    const res = await call(r, post({ commandId: "c-1", type: "thread.unpin", threadId: "t1" }));
    expect(await body(res)).toEqual({ ok: true, sequence: 3 });
    expect(r.store.lastSequence()).toBe(3);
  });

  test("validation failures write no receipt, so a corrected retry can reuse the id", async () => {
    const r = await rig();
    const bad = await call(r, post({ commandId: "c-1", type: "thread.rename", threadId: "t1", title: "   " }));
    expect(bad.status).toBe(400);
    expect(await body(bad)).toEqual({ ok: false, code: "invalid", error: "empty-title" });
    const missing = await call(r, post({ commandId: "c-1", type: "thread.rename", threadId: "nope", title: "x" }));
    expect(missing.status).toBe(404);
    expect((await body(missing)).code).toBe("not_found");
    const good = await call(r, post({ commandId: "c-1", type: "thread.rename", threadId: "t1", title: "fine" }));
    expect(good.status).toBe(200);
  });

  test("malformed requests: bad id, unknown type, bad fields, not JSON", async () => {
    const r = await rig();
    expect((await call(r, post({ commandId: "has space", type: "thread.pin", threadId: "t1" }))).status).toBe(400);
    expect((await call(r, post({ commandId: "x".repeat(65), type: "thread.pin", threadId: "t1" }))).status).toBe(400);
    const unknown = await call(r, post({ commandId: "c", type: "thread.explode", threadId: "t1" }));
    expect(await body(unknown)).toEqual({ ok: false, code: "invalid", error: "unknown-type" });
    const fields = await call(r, post({ commandId: "c", type: "thread.snooze", threadId: "t1", until: "soon" }));
    expect(await body(fields)).toEqual({ ok: false, code: "invalid", error: "bad-until" });
    const text = new Request(URL_BASE + "/api/v2/command", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: URL_BASE, host: "localhost" },
      body: "{}",
    });
    expect((await call(r, text)).status).toBe(415);
    expect((await call(r, get("/api/v2/command"))).status).toBe(405);
  });

  test("an effect with no handler yet answers 501 unsupported", async () => {
    const r = await rig();
    const res = await call(r, post({ commandId: "c", type: "message.dispatch", threadId: "t1", text: "hi", mode: "start" }));
    expect(res.status).toBe(501);
    expect((await body(res)).code).toBe("unsupported");
  });

  test("thread commands take the pane's queue key, project commands their own", async () => {
    const r = await rig();
    await call(r, post({ commandId: "a", type: "thread.pin", threadId: "t1" }));
    await call(r, post({ commandId: "b", type: "project.rename", projectId: "w1", label: "Work" }));
    expect(r.queueKeys).toEqual(["w1:p-t1", "v2:project:w1"]);
  });

  test("two commands on one pane run in order, one at a time", async () => {
    const order: string[] = [];
    const real = createPaneQueue();
    let active = 0;
    const queue: PaneQueue = {
      run: (key, fn) =>
        real.run(key, async () => {
          active += 1;
          expect(active).toBe(1);
          order.push(`start:${key}`);
          await new Promise((res) => setTimeout(res, 10));
          const out = await fn();
          order.push(`end:${key}`);
          active -= 1;
          return out;
        }),
      size: () => real.size(),
    };
    const r = await rig({ queue });
    const [a, b] = await Promise.all([
      call(r, post({ commandId: "a", type: "thread.rename", threadId: "t1", title: "first" })),
      call(r, post({ commandId: "b", type: "thread.rename", threadId: "t1", title: "second" })),
    ]);
    expect((await body(a)).sequence).toBe(4);
    expect((await body(b)).sequence).toBe(5);
    expect(order).toEqual(["start:w1:p-t1", "end:w1:p-t1", "start:w1:p-t1", "end:w1:p-t1"]);
    expect(r.store.getThread("t1")?.title).toBe("second");
  });

  test("a duplicate in flight waits for the first and gets its reply", async () => {
    const r = await rig();
    const cmd = { commandId: "dup", type: "thread.rename", threadId: "t1", title: "once" };
    const [a, b] = await Promise.all([call(r, post(cmd)), call(r, post(cmd))]);
    expect(await body(a)).toEqual(await body(b));
    expect(r.store.lastSequence()).toBe(4);
  });

  test("a busy pane answers 503", async () => {
    const queue: PaneQueue = {
      run: async (key) => {
        throw new PaneBusyError(key);
      },
      size: () => 0,
    };
    const r = await rig({ queue });
    const res = await call(r, post({ commandId: "c", type: "thread.pin", threadId: "t1" }));
    expect(res.status).toBe(503);
    expect(await body(res)).toEqual({ ok: false, code: "busy", error: "pane busy" });
  });

  test("markRead stamps the pane seen and reconciles the herd ingest", async () => {
    const r = await rig();
    r.store.append([{ type: "thread.updated", threadId: "t1", payload: { patch: { unreadDone: true }, at: 1 } }]);
    const res = await call(r, post({ commandId: "m", type: "thread.markRead", threadId: "t1" }));
    expect(res.status).toBe(200);
    expect(r.seen).toEqual(["w1:p-t1"]);
    expect(r.reconciles).toBe(1);
    expect(r.store.getThread("t1")?.unreadDone).toBe(false);
    await call(r, post({ commandId: "u", type: "thread.markUnread", threadId: "t1" }));
    expect(r.unseen).toEqual(["w1:p-t1"]);
    expect(r.reconciles).toBe(2);
  });

  test("unarchive needs the pane alive in the engine", async () => {
    const r = await rig();
    r.store.append([{ type: "thread.archived", threadId: "t1", payload: { reason: "user", at: 1 } }]);
    expect((await call(r, post({ commandId: "x", type: "thread.unarchive", threadId: "t1" }))).status).toBe(200);
    r.store.append([createThread(thread("t3", { paneId: "w1:gone" })), { type: "thread.archived", threadId: "t3", payload: { reason: "pane-closed", at: 1 } }]);
    const gone = await call(r, post({ commandId: "y", type: "thread.unarchive", threadId: "t3" }));
    expect(gone.status).toBe(409);
    expect((await body(gone)).error).toBe("pane-closed");
  });

  test("thread.delete: archived with its pane gone only; a retry of the same id replays the receipt", async () => {
    const r = await rig();
    const live = await call(r, post({ commandId: "d0", type: "thread.delete", threadId: "t1" }));
    expect(live.status).toBe(409);
    expect((await body(live)).error).toBe("not-archived");
    r.store.append([{ type: "thread.archived", threadId: "t1", payload: { reason: "user", at: 1 } }]);
    const open = await call(r, post({ commandId: "d1", type: "thread.delete", threadId: "t1" }));
    expect((await body(open)).error).toBe("pane-open");

    r.store.append([createThread(thread("t3", { paneId: "w1:gone" })), { type: "thread.archived", threadId: "t3", payload: { reason: "pane-closed", at: 1 } }]);
    const ok = await call(r, post({ commandId: "d2", type: "thread.delete", threadId: "t3" }));
    expect(ok.status).toBe(200);
    const first = await body(ok);
    expect(r.store.getThread("t3")).toBeNull();
    const again = await call(r, post({ commandId: "d2", type: "thread.delete", threadId: "t3" }));
    expect(again.status).toBe(200);
    expect(await body(again)).toEqual(first);
    // A new id for a thread that is gone is not found (the client counts it as done).
    expect((await call(r, post({ commandId: "d3", type: "thread.delete", threadId: "t3" }))).status).toBe(404);
  });

  describe("thread.pane.close", () => {
    const closer = () => {
      const closed: string[] = [];
      return { closed, herdr: { closePane: async (paneId: string) => void closed.push(paneId) } };
    };

    test("closes the pane on its queue key, audits it, and archives an active thread as pane-closed", async () => {
      const { closed, herdr } = closer();
      const r = await rig({ herdr });
      r.store.append([{ type: "run.started", threadId: "t1", payload: { run: { id: "run1", threadId: "t1", ordinal: 1, status: "running", startedAt: 1 } } }]);
      const res = await call(r, post({ commandId: "pc1", type: "thread.pane.close", threadId: "t1" }));
      expect(res.status).toBe(200);
      expect(closed).toEqual(["w1:p-t1"]);
      expect(r.queueKeys).toContain("w1:p-t1");
      expect(r.audits).toContainEqual({ action: "pane.close", paneId: "w1:p-t1", detail: { threadId: "t1", via: "v2-command" } });
      const t = r.store.getThread("t1")!;
      expect(t).toMatchObject({ shelf: "archived", archiveReason: "pane-closed", paneAlive: false });
      expect(r.store.openRuns()).toEqual([]);
      expect(r.reconciles).toBe(1);
      // A retry of the same id replays the receipt and does not close again.
      const again = await call(r, post({ commandId: "pc1", type: "thread.pane.close", threadId: "t1" }));
      expect(await body(again)).toEqual(await body(res));
      expect(closed).toHaveLength(1);
    });

    test("an already archived thread only has its paneAlive cleared", async () => {
      const { closed, herdr } = closer();
      const r = await rig({ herdr });
      r.store.append([
        { type: "thread.updated", threadId: "t1", payload: { patch: { paneAlive: true }, at: 1 } },
        { type: "thread.archived", threadId: "t1", payload: { reason: "user", at: 1 } },
      ]);
      const res = await call(r, post({ commandId: "pc2", type: "thread.pane.close", threadId: "t1" }));
      expect(res.status).toBe(200);
      expect(closed).toEqual(["w1:p-t1"]);
      expect(r.store.getThread("t1")).toMatchObject({ shelf: "archived", archiveReason: "user", paneAlive: false });
    });

    test("a pane that is already gone succeeds without calling herdr", async () => {
      const { closed, herdr } = closer();
      const r = await rig({ herdr });
      r.store.append([createThread(thread("t3", { paneId: "w1:gone" }))]);
      const res = await call(r, post({ commandId: "pc3", type: "thread.pane.close", threadId: "t3" }));
      expect(res.status).toBe(200);
      expect(closed).toEqual([]);
      expect(r.audits.filter((a) => a.action === "pane.close")).toEqual([]);
    });

    test("an unknown thread is 404", async () => {
      const { herdr } = closer();
      const r = await rig({ herdr });
      const res = await call(r, post({ commandId: "pc4", type: "thread.pane.close", threadId: "nope" }));
      expect(res.status).toBe(404);
      expect((await body(res)).error).toBe("no-such-thread");
    });
  });

  describe("runtime-request.respond", () => {
    const pending = (r: Rig): RuntimeRequest => {
      const request: RuntimeRequest = {
        id: "req1",
        threadId: "t1",
        kind: "permission",
        prompt: "Allow?",
        options: [{ label: "Yes", keys: ["1"] }, { label: "No", keys: ["2"], destructive: true }],
        status: "pending",
        bindingHash: "h",
        createdAt: 1,
        updatedAt: 1,
      };
      r.store.append([{ type: "runtime-request.updated", threadId: "t1", payload: { request, boundText: "Allow?" } }]);
      return request;
    };

    function fakeRespond(r: Rig, result: (cmd: { requestId: string; optionIndex?: number }) => RespondResult | "commit") {
      const calls: unknown[] = [];
      const handler: RespondHandler = async (cmd, opts) => {
        calls.push({ cmd, opts });
        const out = result(cmd);
        if (out !== "commit") return out;
        const request = { ...r.store.getRequest(cmd.requestId)!, status: "resolved" as const, optionIndex: cmd.optionIndex };
        const { last } = r.store.append([{ type: "runtime-request.updated", threadId: "t1", payload: { request } }], {
          commandId: opts!.commandId!,
          receipt: { type: "runtime-request.respond", result: opts!.receiptResult },
        });
        return { ok: true, sequence: last, request };
      };
      return { handler, calls };
    }

    test("routes to T04's handler with the commandId and the receipt body; a retry returns the same reply", async () => {
      const r0 = await rig();
      pending(r0);
      const { handler, calls } = fakeRespond(r0, () => "commit");
      const effects: EffectRegistry = { "runtime-request.respond": respondEffect(handler) };
      const r = await rig({ store: r0.store, effects });
      const cmd = { commandId: "resp-1", type: "runtime-request.respond", requestId: "req1", optionIndex: 0 };
      const res = await call(r, post(cmd));
      expect(res.status).toBe(200);
      const reply = await body(res);
      expect(reply).toEqual({ ok: true, sequence: 5 });
      expect(calls).toEqual([
        { cmd: { requestId: "req1", optionIndex: 0 }, opts: { commandId: "resp-1", receiptResult: { hash: commandHash(cmd) } } },
      ]);
      const again = await call(r, post(cmd));
      expect(await body(again)).toEqual(reply);
      expect(calls).toHaveLength(1);
      expect(r.audits.at(-1)).toEqual({ action: "v2-command", detail: { type: "runtime-request.respond", threadId: "t1" } });
    });

    test("prompt-changed records command.rejected with a receipt and answers 409, also on retry", async () => {
      const r0 = await rig();
      pending(r0);
      const { handler, calls } = fakeRespond(r0, () => ({ ok: false, code: "prompt-changed", reason: "prompt changed" }));
      const r = await rig({ store: r0.store, effects: { "runtime-request.respond": respondEffect(handler) } });
      const cmd = { commandId: "resp-2", type: "runtime-request.respond", requestId: "req1", optionIndex: 1 };
      const res = await call(r, post(cmd));
      expect(res.status).toBe(409);
      expect(await body(res)).toEqual({ ok: false, code: "prompt-changed", error: "prompt changed" });
      const last = r.store.eventsAfter(4);
      expect(last.map((e) => e.type)).toEqual(["command.rejected"]);
      expect(last[0]!.commandId).toBe("resp-2");
      const again = await call(r, post(cmd));
      expect(again.status).toBe(409);
      expect((await body(again)).code).toBe("prompt-changed");
      expect(calls).toHaveLength(1);
    });

    test("not_found / invalid / busy map to 404 / 400 / 503 and write no receipt", async () => {
      const results: RespondResult[] = [
        { ok: false, code: "not_found", reason: "no-such-request" },
        { ok: false, code: "invalid", reason: "bad-option" },
        { ok: false, code: "busy", reason: "pane busy" },
        { ok: false, code: "failed", reason: "key send failed" },
      ];
      let i = 0;
      const r0 = await rig();
      const { handler } = fakeRespond(r0, () => results[i++]!);
      const r = await rig({ store: r0.store, effects: { "runtime-request.respond": respondEffect(handler) } });
      const statuses: number[] = [];
      for (let k = 0; k < results.length; k++) {
        statuses.push((await call(r, post({ commandId: "same", type: "runtime-request.respond", requestId: "req1", optionIndex: 0 }))).status);
      }
      expect(statuses).toEqual([404, 400, 503, 502]);
      expect(r.store.receipt("same")).toBeNull();
    });
  });
});

// ── Shell stream ─────────────────────────────────────────────────────────────────────────────────

describe("GET /api/v2/shell", () => {
  test("a fresh attach gets a snapshot, synchronized, build, then live shell events only", async () => {
    const r = await rig();
    const res = await call(r, get("/api/v2/shell?client=phone"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const s = sse(res);
    let frames = await s.until((f) => named(f, "build").length > 0);
    expect(frames[0]).toMatchObject({ id: "3", event: "snapshot" });
    const snap = frames[0]!.data as { sequence: number; projects: unknown[]; threads: { id: string }[]; requests: unknown[] };
    expect(snap.sequence).toBe(3);
    expect(snap.threads.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(frames[1]).toEqual({ id: "3", event: "synchronized", data: { sequence: 3, herdr: "connected" } });
    // T12: the herdr link rides on the snapshot; `device` only when per-device auth is on.
    expect((frames[0]!.data as { herdr?: string; device?: unknown }).herdr).toBe("connected");
    expect((frames[0]!.data as { device?: unknown }).device).toBeUndefined();
    expect(named(frames, "build")[0]!.data).toBe("build-1");

    r.store.append([item("i1", "t1"), rename("t1", "live")]);
    frames = await s.until((f) => eventsOf(f).length > 0);
    const events = eventsOf(frames);
    expect(events.map((e) => e.type)).toEqual(["thread.updated"]);
    expect(named(frames, "event")[0]!.id).toBe("5");
    expect(r.conn[0]).toEqual({ kind: "sse.attach", sid: "phone" });
    await s.cancel();
    expect(r.routes.streamCount()).toBe(0);
    expect(r.conn.at(-1)).toMatchObject({ kind: "sse.detach", sid: "phone", why: "cancel" });
  });

  test("resume with a recent cursor replays only the missed shell events, in order (?after= or Last-Event-ID)", async () => {
    const r = await rig();
    r.store.append([rename("t1", "a"), item("i1", "t1"), rename("t2", "b")]);
    for (const req of [get("/api/v2/shell?after=3"), get("/api/v2/shell", { "last-event-id": "3" })]) {
      const s = sse(await call(r, req));
      const frames = await s.until(synced);
      expect(named(frames, "snapshot")).toEqual([]);
      expect(eventsOf(frames).map((e) => e.sequence)).toEqual([4, 6]);
      expect(named(frames, "synchronized")[0]!.data).toEqual({ sequence: 6, herdr: "connected" });
      await s.cancel();
    }
  });

  test("resume 200 behind, below minSequence, or ahead of the last sequence gets a snapshot", async () => {
    const r = await rig();
    r.store.append(Array.from({ length: 200 }, (_, i) => rename("t1", `n${i}`)));
    const behind = sse(await call(r, get("/api/v2/shell?after=3")));
    let frames = await behind.until(synced);
    expect(named(frames, "snapshot")).toHaveLength(1);
    expect(eventsOf(frames)).toEqual([]);
    await behind.cancel();

    const ahead = sse(await call(r, get("/api/v2/shell?after=9999")));
    frames = await ahead.until(synced);
    expect(named(frames, "snapshot")).toHaveLength(1);
    await ahead.cancel();

    const pruned = await rig({ store: { ...r.store, minSequence: () => 150 } as ThreadStore });
    const below = sse(await call(pruned, get("/api/v2/shell?after=149")));
    frames = await below.until(synced);
    expect(named(frames, "snapshot")).toHaveLength(1);
    await below.cancel();
    const at = sse(await call(pruned, get("/api/v2/shell?after=190")));
    frames = await at.until(synced);
    expect(named(frames, "snapshot")).toHaveLength(0);
    expect(eventsOf(frames)).toHaveLength(13);
    await at.cancel();
  });

  test("a quiet stream gets keep-alive and ping once the clock passes the keep-alive", async () => {
    const r = await rig();
    const s = sse(await call(r, get("/api/v2/shell")));
    await s.until((f) => named(f, "build").length > 0);
    r.clock.t += 5_000;
    r.tick();
    expect(named(await s.until(() => false, 50), "ping")).toEqual([]);
    r.clock.t += 15_000;
    r.tick();
    const frames = await s.until((f) => named(f, "ping").length > 0);
    expect(named(frames, "ping")[0]).toEqual({ event: "ping", data: { sequence: 3, herdr: "connected" } });
    expect(frames.some((f) => f.comment === "keep-alive")).toBe(true);
    await s.cancel();
  });

  test("a same-client reattach closes the old stream", async () => {
    const r = await rig();
    const a = sse(await call(r, get("/api/v2/shell?client=phone")));
    await a.until(synced);
    const b = sse(await call(r, get("/api/v2/shell?client=phone")));
    await b.until(synced);
    await a.drain();
    expect(a.done).toBe(true);
    expect(r.routes.streamCount("shell")).toBe(1);
    expect(r.conn.filter((e) => e.kind === "sse.detach")).toEqual([
      expect.objectContaining({ kind: "sse.detach", sid: "phone", why: "replaced" }),
    ]);
    const other = sse(await call(r, get("/api/v2/shell?client=desk")));
    await other.until(synced);
    expect(r.routes.streamCount("shell")).toBe(2);
    await b.cancel();
    await other.cancel();
  });
});

// ── Thread stream ────────────────────────────────────────────────────────────────────────────────

describe("GET /api/v2/thread/:id", () => {
  test("an unknown thread is a 404 before any streaming", async () => {
    const r = await rig();
    const res = await call(r, get("/api/v2/thread/nope"));
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ ok: false, code: "not_found", error: "no-such-thread" });
  });

  test("snapshot, then only this thread's live events; watchers follow attach and detach", async () => {
    const r = await rig();
    r.store.append([startRun("r1", "t1", 1), item("i1", "t1", "r1"), item("x1", "t2")]);
    const s = sse(await call(r, get("/api/v2/thread/t1")));
    let frames = await s.until(synced);
    const snap = snapshotOf(frames[0]) as { thread: { id: string }; runs: { id: string }[]; items: { id: string }[]; historyCursor: string | null };
    expect(frames[0]!.event).toBe("snapshot");
    expect(snap.thread.id).toBe("t1");
    expect(snap.runs.map((x) => x.id)).toEqual(["r1"]);
    expect(snap.items.map((x) => x.id)).toEqual(["i1"]);
    expect(snap.historyCursor).toBeNull();
    expect(r.watchers.count("t1")).toBe(1);

    r.store.append([item("x2", "t2"), item("i2", "t1", "r1"), rename("t2", "other")]);
    frames = await s.until((f) => eventsOf(f).length > 0);
    expect(eventsOf(frames).map((e) => (e.payload as { item?: { id: string } }).item?.id)).toEqual(["i2"]);
    await s.cancel();
    expect(r.watchers.count("t1")).toBe(0);
  });

  test("the snapshot frame is gzipped under a marker and decodes to the same snapshot", async () => {
    const r = await rig();
    r.store.append([startRun("r1", "t1", 1), item("i1", "t1", "r1"), item("i2", "t1", "r1")]);
    const s = sse(await call(r, get("/api/v2/thread/t1")));
    const frames = await s.until(synced);
    const wire = frames[0]!.data as { gz?: string; thread?: unknown };
    expect(frames[0]!.event).toBe("snapshot");
    expect(typeof wire.gz).toBe("string");
    expect(wire.thread).toBeUndefined();
    const snap = snapshotOf(frames[0]);
    expect(frames[0]!.id).toBe(String(snap.sequence));
    expect(snap).toEqual(r.store.snapshotThread("t1") as unknown as Record<string, unknown>);
    await s.cancel();
  });

  test("replay is scoped to the thread; a thread more than 128 events behind gets a snapshot", async () => {
    const r = await rig();
    r.store.append([item("a", "t1"), item("b", "t2"), item("c", "t1")]);
    const s = sse(await call(r, get("/api/v2/thread/t1?after=3")));
    const frames = await s.until(synced);
    expect(named(frames, "snapshot")).toEqual([]);
    expect(eventsOf(frames).map((e) => e.sequence)).toEqual([4, 6]);
    await s.cancel();

    // 200 events of another thread do not push t1 out of replay range.
    r.store.append(Array.from({ length: 200 }, (_, i) => rename("t2", `n${i}`)));
    const quiet = sse(await call(r, get("/api/v2/thread/t1?after=6")));
    expect(named(await quiet.until(synced), "snapshot")).toEqual([]);
    await quiet.cancel();

    r.store.append(Array.from({ length: 129 }, (_, i) => rename("t1", `m${i}`)));
    const far = sse(await call(r, get("/api/v2/thread/t1?after=6")));
    expect(named(await far.until(synced), "snapshot")).toHaveLength(1);
    await far.cancel();
  });

  test("an archived thread streams its stored history and idles", async () => {
    const r = await rig();
    r.store.append([item("i1", "t1"), { type: "thread.archived", threadId: "t1", payload: { reason: "pane-closed", at: 2 } }]);
    const s = sse(await call(r, get("/api/v2/thread/t1")));
    const frames = await s.until(synced);
    const snap = snapshotOf(frames[0]) as { thread: { shelf: string }; items: { id: string }[] };
    expect(snap.thread.shelf).toBe("archived");
    expect(snap.items.map((x) => x.id)).toEqual(["i1"]);
    expect(s.done).toBe(false);
    await s.cancel();
  });

  test("a consumer more than the limit behind is sent reset and closed", async () => {
    const r = await rig({ maxBehindBytes: 4_000 });
    const res = await call(r, get("/api/v2/thread/t1"));
    expect(r.watchers.count("t1")).toBe(1);
    // Nobody reads: the queue fills.
    for (let i = 0; i < 20; i++) r.store.append([item(`big${i}`, "t1", null, "x".repeat(500))]);
    expect(r.routes.streamCount("thread")).toBe(0);
    expect(r.watchers.count("t1")).toBe(0);
    const frames = await sse(res).drain();
    expect(frames.at(-1)?.event).toBe("reset");
    const ids = eventsOf(frames).map((e) => e.sequence);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(20);
  });

  test("attach marks the thread seen only for a same-origin browser request or the seen header", async () => {
    const r = await rig();
    const plain = sse(await call(r, get("/api/v2/thread/t1")));
    await plain.until(synced);
    expect(r.seen).toEqual([]);
    const browser = sse(await call(r, get("/api/v2/thread/t1", { "sec-fetch-site": "same-origin" })));
    await browser.until(synced);
    const cross = sse(await call(r, get("/api/v2/thread/t1", { "sec-fetch-site": "cross-site" })));
    await cross.until(synced);
    const header = sse(await call(r, get("/api/v2/thread/t2", { [SEEN_HEADER]: "1" })));
    await header.until(synced);
    expect(r.seen).toEqual(["w1:p-t1", "w1:p-t2"]);
    expect(r.reconciles).toBe(2);
    for (const s of [plain, browser, cross, header]) await s.cancel();
  });

  test("a stream never sends an event at or below a sequence it already sent", async () => {
    const r = await rig();
    const s = sse(await call(r, get("/api/v2/thread/t1?after=3")));
    await s.until(synced);
    r.store.append([item("a", "t1"), item("b", "t1")]);
    const frames = await s.until((f) => eventsOf(f).length >= 2);
    const seqs = eventsOf(frames).map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    await s.cancel();
  });
});

// ── History ──────────────────────────────────────────────────────────────────────────────────────

describe("GET /api/v2/thread/:id/history", () => {
  async function seeded(runs: number): Promise<Rig> {
    const r = await rig();
    const drafts: EventDraft[] = [item("loose0", "t1")];
    for (let k = 1; k <= runs; k++) {
      drafts.push(startRun(`r${k}`, "t1", k), item(`r${k}a`, "t1", `r${k}`), item(`r${k}b`, "t1", `r${k}`));
      if (k % 4 === 0) drafts.push(item(`loose${k}`, "t1"));
    }
    r.store.append(drafts);
    return r;
  }

  const page = async (r: Rig, q: string) => (await (await call(r, get(`/api/v2/thread/t1/history${q}`))).json()) as {
    runs: { run: { id: string }; items: { id: string }[] }[];
    loose: { id: string }[];
    nextCursor: string | null;
  };

  test("paging back from the snapshot cursor reaches nextCursor null with no duplicate and no gap", async () => {
    const r = await seeded(25);
    const snap = r.store.snapshotThread("t1")!;
    const seen = snap.items.map((x) => x.id);
    let cursor = snap.historyCursor;
    let pages = 0;
    while (cursor) {
      const p = await page(r, `?before=${encodeURIComponent(cursor)}&limit=4`);
      expect(p.runs.length).toBeLessThanOrEqual(4);
      const ids = [...p.runs.flatMap((x) => x.items.map((i) => i.id)), ...p.loose.map((i) => i.id)];
      seen.unshift(...ids);
      cursor = p.nextCursor;
      pages += 1;
    }
    // The snapshot now holds SNAPSHOT_RUNS runs (spec 26), so the rest pages in `limit` runs at a time.
    expect(pages).toBe(Math.ceil((25 - SNAPSHOT_RUNS) / 4));
    const all = r.store.recentItems("t1", 1_000).map((x) => x.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...all].sort());
  });

  test("items with no run come back in loose; runs oldest first", async () => {
    const r = await seeded(8);
    const p = await page(r, `?limit=20`);
    expect(p.runs.map((x) => x.run.id)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]);
    expect(p.loose.map((x) => x.id)).toEqual(["loose0", "loose4", "loose8"]);
    expect(p.nextCursor).toBeNull();
  });

  test("limit defaults to 5 and clamps at 20", async () => {
    const r = await seeded(30);
    expect((await page(r, "")).runs).toHaveLength(5);
    expect((await page(r, "?limit=500")).runs).toHaveLength(20);
    expect((await page(r, "?limit=-3")).runs).toHaveLength(5);
  });

  test("an unknown or malformed cursor answers an empty page", async () => {
    const r = await seeded(3);
    expect(await page(r, "?before=%%%")).toEqual({ runs: [], loose: [], nextCursor: null });
    expect(await page(r, `?before=${btoa("abc")}`)).toEqual({ runs: [], loose: [], nextCursor: null });
    const p = await page(r, `?before=${encodeHistoryCursor(0)}`);
    expect(p).toEqual({ runs: [], loose: [], nextCursor: null });
  });

  test("unknown thread is 404", async () => {
    const r = await rig();
    expect((await call(r, get("/api/v2/thread/nope/history"))).status).toBe(404);
  });
});

describe("GET /api/v2/search", () => {
  type Hit = { threadId: string; itemId: string; role: string; excerpt: string; ranges: { start: number; end: number }[]; archived: boolean };
  const search = async (r: Rig, q: string, headers: Record<string, string> = {}) => {
    const res = await call(r, get(`/api/v2/search${q}`, headers));
    return { status: res.status, body: (await res.json()) as { results: Hit[]; truncated: boolean; query: string; code?: string; error?: string } };
  };

  async function withText(): Promise<Rig> {
    const r = await rig();
    r.store.append([
      item("m1", "t1", null, "the quick brown fox jumps"),
      item("m2", "t1", null, "another fox in the henhouse"),
      item("m3", "t2", null, "fox hunting is a topic"),
      item("m4", "t2", null, "nothing relevant"),
    ]);
    return r;
  }

  test("answers matches with thread, item, role, excerpt and ranges", async () => {
    const r = await withText();
    const { status, body: b } = await search(r, "?q=fox");
    expect(status).toBe(200);
    expect(b.query).toBe("fox");
    expect(b.results.map((x) => x.itemId)).toEqual(["m3", "m2", "m1"]);
    const m3 = b.results[0]!;
    expect(m3).toMatchObject({ threadId: "t2", role: "assistant", excerpt: "fox hunting is a topic", archived: false });
    expect(m3.ranges).toEqual([{ start: 0, end: 3 }]);
  });

  test("a missing, overlong or one-character query: 400 for the first two, no results for the last", async () => {
    const r = await withText();
    expect((await search(r, "")).status).toBe(400);
    expect((await search(r, "?q=" + "a".repeat(201))).status).toBe(400);
    expect((await search(r, "?q=" + "a".repeat(200))).status).toBe(200);
    const one = await search(r, "?q=f");
    expect(one.status).toBe(200);
    expect(one.body.results).toEqual([]);
    expect((await search(r, "?q=%22%20AND%20NEAR(")).status).toBe(200);
  });

  test("limit: junk is 400, zero or negative is the default, and it never exceeds 50", async () => {
    const r = await withText();
    expect((await search(r, "?q=fox&limit=abc")).status).toBe(400);
    expect((await search(r, "?q=fox&limit=1.5")).status).toBe(400);
    expect((await search(r, "?q=fox&limit=2")).body.results).toHaveLength(2);
    expect((await search(r, "?q=fox&limit=0")).body.results).toHaveLength(3);
    expect((await search(r, "?q=fox&limit=-4")).body.results).toHaveLength(3);
    const wide = await rig();
    for (let k = 0; k < 30; k++) wide.store.append([createThread(thread(`x${k}`, { paneId: `w1:p-x${k}`, terminalId: `tm-x${k}` })), item(`w${k}`, `x${k}`, null, "omega")]);
    const big = await search(wide, "?q=omega&limit=500");
    expect(big.body.results.length).toBe(30);
    expect(big.body.results.length).toBeLessThanOrEqual(50);
  });

  test("archived threads only with ?archived=1", async () => {
    const r = await withText();
    r.store.append([{ type: "thread.archived", threadId: "t2", payload: { reason: "user", at: 5 } }]);
    expect((await search(r, "?q=hunting")).body.results).toEqual([]);
    const all = await search(r, "?q=hunting&archived=1");
    expect(all.body.results.map((x) => [x.itemId, x.archived])).toEqual([["m3", true]]);
  });

  test("a read-only device may search; POST is 405", async () => {
    const r = await rig({ cfg: cfg({ deviceHeader: "x-device", deviceAllowlist: ["phone"] }) });
    expect((await search(r, "?q=hello", { "x-device": "laptop" })).status).toBe(200);
    const res = await call(r, new Request(`${URL_BASE}/api/v2/search?q=hi`, { method: "POST" }));
    expect(res.status).toBe(405);
  });

  test("with v2 off the route answers v2-disabled", async () => {
    const r = await rig({ store: null });
    const { status, body: b } = await search(r, "?q=hello");
    expect(status).toBe(503);
    expect(b.code).toBe("v2-disabled");
  });
});

describe("resumeCursor", () => {
  test("takes the larger of ?after= and Last-Event-ID and ignores junk", () => {
    const at = (q: string, h: Record<string, string> = {}) => {
      const req = get(`/api/v2/shell${q}`, h);
      return resumeCursor(req, new URL(req.url));
    };
    expect(at("")).toBe(0);
    expect(at("?after=12")).toBe(12);
    expect(at("", { "last-event-id": "9" })).toBe(9);
    expect(at("?after=12", { "last-event-id": "30" })).toBe(30);
    expect(at("?after=-4")).toBe(0);
    expect(at("?after=abc", { "last-event-id": "1e9" })).toBe(0);
  });
});

