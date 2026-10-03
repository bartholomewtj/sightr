import { describe, expect, test } from "bun:test";

import { CONN_MAX_EVENTS, normalizePhoneEvent } from "../shared/conn.ts";
import type { Config } from "./config.ts";
import { ConnLog } from "./conn-log.ts";
import { connRoute } from "./conn-route.ts";
import { createSnapshotEvents, eventsRoute } from "./events-route.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { SnapshotDeps } from "./snapshot-route.ts";
import { StateEngine } from "./state-engine.ts";

const cfg = (over: Partial<Config> = {}): Config =>
  ({ allowAnyHost: true, allowedOrigins: [], trustedUser: "", publicHosts: [], tailscaleHosts: [], skipServe: false, deviceHeader: "", deviceAllowlist: [], submitKeys: [], notifyDelayMs: 0, readLines: 100, ...over }) as unknown as Config;

function memoryLog(now = () => Date.parse("2026-10-03T00:00:00Z")) {
  const lines: Record<string, unknown>[] = [];
  return { log: new ConnLog((line) => { lines.push(JSON.parse(line)); }, now), lines };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/conn", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const base = { at: 1_000, sid: "abc-123" };

const streamDeps = () => ({
  cfg: cfg(),
  engine: { current: () => ({ agents: [], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" as const }) },
  activity: { get: () => undefined },
  worktrees: { decorate: async <T>(workspaces: T[]) => workspaces, invalidate: () => undefined },
  workdir: { enabled: false },
  journals: null,
  transcripts: null,
  offerHistory: () => false,
}) as unknown as SnapshotDeps;
const streamReq = (sid: string) => new Request(`http://localhost/api/events?client=${sid}`, { headers: { host: "localhost" } });

describe("normalizePhoneEvent", () => {
  test("keeps only contract fields", () => {
    expect(normalizePhoneEvent({ ...base, kind: "gap", ms: 5_000, lost: true, ended: "live", text: "secret", paneId: "w1:p1" }))
      .toEqual({ ...base, kind: "gap", ms: 5_000, lost: true, ended: "live" });
  });

  test("rejects unknown kinds, missing ids and bad numbers", () => {
    expect(normalizePhoneEvent({ ...base, kind: "reply", text: "hi" })).toBeNull();
    expect(normalizePhoneEvent({ kind: "lost", at: 1 })).toBeNull();
    expect(normalizePhoneEvent({ ...base, sid: "../../etc", kind: "lost" })).toBeNull();
    expect(normalizePhoneEvent({ ...base, kind: "gap", ms: -1 })).toBeNull();
    expect(normalizePhoneEvent({ ...base, kind: "gap", ms: "5" })).toBeNull();
  });

  test("a free-text token is dropped, not passed through", () => {
    const e = normalizePhoneEvent({ ...base, net: "4g; DROP TABLE", kind: "boot", platform: "a b c", standalone: true });
    expect(e).toEqual({ ...base, kind: "boot", platform: "other", standalone: true });
  });

  test("window stats are rebuilt per known class", () => {
    const e = normalizePhoneEvent({
      ...base, kind: "window", visibleMs: 60_000,
      stats: { snapshot: { n: 3, ok: 2, timeout: 1, buckets: [1, 1, 1], maxMs: 900, extra: "x" }, bogus: { n: 9 }, pane: { n: 0 } },
    });
    expect(e).toEqual({
      ...base, kind: "window", visibleMs: 60_000,
      stats: { snapshot: { n: 3, ok: 2, http4: 0, http5: 0, timeout: 1, network: 0, buckets: [1, 1, 1, 0, 0, 0, 0, 0], maxMs: 900 } },
    });
  });
});

describe("POST /api/conn", () => {
  test("writes each valid event with the device, drops the rest", async () => {
    const { log, lines } = memoryLog();
    const res = await connRoute(
      post({ events: [{ ...base, kind: "lost" }, { kind: "nope" }, { ...base, kind: "online", on: false }] }, { "x-device": "pixel" }),
      cfg({ deviceHeader: "x-device" }),
      log,
    );
    expect(res.status).toBe(204);
    await Promise.resolve();
    expect(lines).toEqual([
      { ts: "2026-10-03T00:00:00.000Z", src: "phone", device: "pixel", ...base, kind: "lost" },
      { ts: "2026-10-03T00:00:00.000Z", src: "phone", device: "pixel", ...base, kind: "online", on: false },
    ]);
  });

  test("caps the batch", async () => {
    const { log, lines } = memoryLog();
    const events = Array.from({ length: CONN_MAX_EVENTS + 50 }, () => ({ ...base, kind: "lost" }));
    await connRoute(post({ events }), cfg(), log);
    expect(lines.length).toBe(CONN_MAX_EVENTS);
  });

  test("refuses the wrong method, content type, oversize and bad shape", async () => {
    const { log, lines } = memoryLog();
    expect((await connRoute(new Request("http://localhost/api/conn"), cfg(), log)).status).toBe(405);
    expect((await connRoute(post("{}", { "content-type": "text/plain" }), cfg(), log)).status).toBe(415);
    expect((await connRoute(post("x".repeat(60_000)), cfg(), log)).status).toBe(413);
    expect((await connRoute(post("{nope"), cfg(), log)).status).toBe(400);
    expect((await connRoute(post({ events: 3 }), cfg(), log)).status).toBe(400);
    expect(lines).toEqual([]);
  });

  test("passes the read gate", async () => {
    const { log } = memoryLog();
    expect((await connRoute(post({ events: [] }, { origin: "https://evil.example.com" }), cfg(), log)).status).toBe(403);
  });

  test("off: accepted and discarded", async () => {
    const res = await connRoute(post({ events: [{ ...base, kind: "lost" }] }), cfg(), new ConnLog(null));
    expect(res.status).toBe(204);
  });
});

describe("bridge-side lines", () => {
  test("an SSE stream logs attach and, on cancel, how long it lived", async () => {
    const { log, lines } = memoryLog();
    let t = 1_000;
    const events = createSnapshotEvents(async () => "{}");
    const res = eventsRoute(streamReq("abc-123"), streamDeps(), events, log, () => t);
    expect(lines).toEqual([expect.objectContaining({ src: "bridge", kind: "sse.attach", sid: "abc-123" })]);
    t = 46_000;
    await res.body!.cancel();
    expect(lines[1]).toEqual(expect.objectContaining({ kind: "sse.detach", sid: "abc-123", upMs: 45_000, why: "cancel" }));
    events.close();
  });

  test("a newer stream from the same page marks the old one replaced, once", async () => {
    const { log, lines } = memoryLog();
    const events = createSnapshotEvents(async () => "{}");
    let t = 0;
    const first = eventsRoute(streamReq("abc"), streamDeps(), events, log, () => t);
    t = 10;
    eventsRoute(streamReq("abc"), streamDeps(), events, log, () => t);
    await first.body!.cancel().catch(() => {});
    const detaches = lines.filter((l) => l.kind === "sse.detach");
    expect(detaches).toEqual([expect.objectContaining({ why: "replaced", upMs: 10 })]);
    events.close();
  });

  test("the engine reports Herdr link changes, not every failed poll", async () => {
    let fail = false;
    const herdr = {
      sessionSnapshot: () => (fail ? Promise.reject(new Error("pipe gone")) : Promise.resolve({ version: "0.7.2", protocol: 16, workspaces: [], tabs: [], panes: [], agents: [] })),
    };
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    const seen: Array<[string, string | undefined]> = [];
    engine.onLink((status, err) => seen.push([status, err]));
    const poll = () => (engine as unknown as { poll(): Promise<void> }).poll();
    await poll();
    await poll();
    fail = true;
    await poll();
    await poll();
    fail = false;
    await poll();
    expect(seen).toEqual([["connected", undefined], ["disconnected", "pipe gone"], ["connected", undefined]]);
  });
});
