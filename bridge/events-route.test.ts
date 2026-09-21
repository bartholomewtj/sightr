import { describe, expect, test } from "bun:test";
import { createSnapshotEvents, eventsRoute, EVENT_COALESCE_MS, EVENT_KEEPALIVE_MS } from "./events-route.ts";
import type { Config } from "./config.ts";
import type { SnapshotDeps } from "./snapshot-route.ts";

function timers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    api: {
      setTimeout: (fn: () => void) => { const id = ++next; pending.set(id, fn); return id as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout: (id: ReturnType<typeof setTimeout>) => { pending.delete(id as unknown as number); },
      setInterval: (fn: () => void) => { const id = ++next; pending.set(id, fn); return id as unknown as ReturnType<typeof setInterval>; },
      clearInterval: (id: ReturnType<typeof setInterval>) => { pending.delete(id as unknown as number); }
    },
    fire() { for (const fn of [...pending.values()]) fn(); },
    fireLast() { for (const fn of [...pending.values()].slice(-1)) fn(); }
  };
}

/** Real-clock wait for an async emit to reach every client (the build id read is a real file read). */
async function settle(done: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !done(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe("snapshot events", () => {
  const eventDeps = (allowed: boolean): SnapshotDeps => ({
    cfg: { allowAnyHost: allowed, allowedOrigins: [], trustedUser: "", publicHosts: [], tailscaleHosts: [], skipServe: false } as unknown as Config,
  } as unknown as SnapshotDeps);

  test("requires the read access gate", () => {
    const events = createSnapshotEvents(async () => "{}");
    expect(eventsRoute(new Request("http://localhost/api/events"), eventDeps(false), events).status).toBe(403);
    events.close();
  });

  test("coalesces updates to one snapshot event", async () => {
    const clock = timers();
    const sent: string[] = [];
    let snapshots = 0;
    const events = createSnapshotEvents(async () => { snapshots++; return JSON.stringify({ value: 1 }); }, () => 0, clock.api);
    events.attach({ send: (chunk) => sent.push(chunk), close: () => {} });
    events.notify(); events.notify();
    expect(sent).toEqual([]);
    clock.fireLast();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(snapshots).toBe(1);
    expect(EVENT_COALESCE_MS).toBe(250);
    events.close();
  });

  test("two clients without a per-client render share one snapshot per tick", async () => {
    const clock = timers();
    const a: string[] = [];
    const b: string[] = [];
    let snapshots = 0;
    const events = createSnapshotEvents(async () => { snapshots++; return JSON.stringify({ tick: snapshots }); }, () => 0, clock.api);
    events.attach({ send: (chunk) => a.push(chunk), close: () => {} }, "phone");
    events.attach({ send: (chunk) => b.push(chunk), close: () => {} }, "desktop");
    events.notify();
    clock.fireLast();
    await settle(() => a.length > 0 && b.length > 0);
    expect(snapshots).toBe(1);
    expect(a[0]).toBe(b[0]);
    expect(a[0]).toContain('"tick":1');
    events.close();
  });

  test("a client with its own render is not fed the shared snapshot", async () => {
    const clock = timers();
    const own: string[] = [];
    const plain: string[] = [];
    const events = createSnapshotEvents(async () => JSON.stringify({ shared: true }), () => 0, clock.api);
    events.attach({ send: (chunk) => own.push(chunk), close: () => {}, render: async () => JSON.stringify({ own: true }) }, "gated");
    events.attach({ send: (chunk) => plain.push(chunk), close: () => {} }, "open");
    events.notify();
    clock.fireLast();
    await settle(() => own.length > 0 && plain.length > 0);
    expect(own[0]).toContain('"own":true');
    expect(plain[0]).toContain('"shared":true');
    events.close();
  });

  test("replaces an earlier stream for the same client", () => {
    const clock = timers();
    const events = createSnapshotEvents(async () => "{}", () => 0, clock.api);
    let closed = 0;
    events.attach({ send: () => {}, close: () => { closed++; } }, "phone");
    events.attach({ send: () => {}, close: () => { closed++; } }, "phone");
    expect(closed).toBe(1);
    expect(events.clientCount()).toBe(1);
    events.close();
  });

  test("keep-alive pings a quiet client without a snapshot body", async () => {
    const clock = timers();
    let now = 0;
    const sent: string[] = [];
    const events = createSnapshotEvents(async () => JSON.stringify({ value: 2 }), () => now, clock.api);
    events.attach({ send: (chunk) => sent.push(chunk), close: () => {} });
    now = EVENT_KEEPALIVE_MS;
    clock.fire();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(sent.some((chunk) => chunk.startsWith(": keep-alive"))).toBe(true);
    expect(sent.some((chunk) => chunk.startsWith("event: ping"))).toBe(true);
    expect(sent.some((chunk) => chunk.startsWith("event: snapshot"))).toBe(false);
    events.close();
  });
});
