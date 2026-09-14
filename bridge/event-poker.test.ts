import { describe, expect, test } from "bun:test";

import {
  buildSubscriptions,
  EventPoker,
  sameIdSet,
  STABLE_MS,
  type Subscription,
  type PokerClock,
} from "./event-poker.ts";
import type { HerdrClient } from "./herdr-client.ts";

// EventPoker owns the stream lifecycle (ack → healthy, events → debounced poke, down → backoff
// reconnect). The socket itself lives in HerdrClient.subscribeEvents and stays untested; here we
// fake it so tests drive ack/event/down synchronously and assert the decisions.

class FakeClock implements PokerClock<number> {
  private nextId = 1;
  public now = 0;
  readonly scheduled: number[] = [];
  private timers = new Map<number, { at: number; fn: () => void }>();

  schedule(fn: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.scheduled.push(delayMs);
    this.timers.set(id, { at: this.now + delayMs, fn });
    return id;
  }

  cancel(id: number): void {
    this.timers.delete(id);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
    }
    this.now = target;
  }
}

interface FakeStream {
  subscriptions: Subscription[];
  onUp: () => void;
  onEvent: (event: string, data: unknown) => void;
  onDown: (reason: string) => void;
  closed: boolean;
}

class FakeClient {
  readonly streams: FakeStream[] = [];
  subscribeEvents(opts: {
    subscriptions: Subscription[];
    onUp: () => void;
    onEvent: (event: string, data: unknown) => void;
    onDown: (reason: string) => void;
  }): { close(): void } {
    const stream: FakeStream = { ...opts, closed: false };
    this.streams.push(stream);
    return {
      close: () => {
        if (stream.closed) return;
        stream.closed = true;
        stream.onDown("closed");
      },
    };
  }
  get last(): FakeStream {
    const s = this.streams[this.streams.length - 1];
    if (!s) throw new Error("no stream");
    return s;
  }
}

function capturingLog(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines;
}

function makePoker(opts?: { debounceMs?: number; backoffMs?: number[] }) {
  const client = new FakeClient();
  const clock = new FakeClock();
  const poker = new EventPoker(client as unknown as HerdrClient, {
    debounceMs: opts?.debounceMs ?? 10,
    backoffMs: opts?.backoffMs ?? [10, 20],
    clock,
  });
  const pokes: number[] = [];
  const health: boolean[] = [];
  poker.onPoke(() => pokes.push(1));
  poker.onHealth((h) => health.push(h));
  return { client, clock, poker, pokes, health };
}

describe("buildSubscriptions / sameIdSet", () => {
  test("emits the global set (no layout/worktree/scroll/output) plus one scoped status sub per pane", () => {
    const subs = buildSubscriptions(["w1:p1", "w2:p3"]);
    const types = subs.map((s) => s.type);
    expect(types).toContain("pane.created");
    expect(types).toContain("pane.agent_detected");
    expect(types).toContain("workspace.focused");
    expect(types).not.toContain("layout.updated");
    expect(types).not.toContain("pane.scroll_changed");
    expect(types).not.toContain("pane.output_matched");
    const scoped = subs.filter((s) => s.type === "pane.agent_status_changed");
    expect(scoped).toEqual([
      { type: "pane.agent_status_changed", pane_id: "w1:p1" },
      { type: "pane.agent_status_changed", pane_id: "w2:p3" },
    ]);
    expect(subs.find((s) => s.type === "pane.created")?.pane_id).toBeUndefined();
  });

  test("sameIdSet ignores order and duplicates", () => {
    expect(sameIdSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameIdSet(["a", "a", "b"], ["a", "b"])).toBe(true);
    expect(sameIdSet(["a"], ["a", "b"])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
  });
});

describe("EventPoker — health", () => {
  test("goes healthy on ack and unhealthy on down, notifying each transition once", () => {
    const { client, poker, health } = makePoker();
    poker.start();
    client.last.onUp();
    client.last.onUp();
    expect(health).toEqual([true]);
    client.last.onDown("socket error");
    expect(health).toEqual([true, false]);
    poker.stop();
  });
});

describe("EventPoker — debounced poke", () => {
  test("coalesces a burst of events into a single trailing poke", () => {
    const { client, clock, poker, pokes } = makePoker({ debounceMs: 10 });
    poker.start();
    client.last.onUp();
    client.last.onEvent("pane_created", {});
    client.last.onEvent("pane_agent_detected", {});
    client.last.onEvent("pane_agent_detected", {});
    expect(pokes.length).toBe(0);
    clock.advance(9);
    expect(pokes.length).toBe(0);
    clock.advance(1);
    expect(pokes.length).toBe(1);
    poker.stop();
  });
});

describe("EventPoker — reconnect backoff", () => {
  test("ack-then-drop keeps stepping through 1000, 2000, and 5000 ms", () => {
    const { client, clock, poker, health } = makePoker({ backoffMs: [1000, 2000, 5000] });
    poker.start();
    client.last.onUp();

    client.last.onDown("boom");
    expect(clock.scheduled.at(-1)).toBe(1000);
    clock.advance(1000);
    client.last.onUp();
    client.last.onDown("boom");
    expect(clock.scheduled.at(-1)).toBe(2000);
    clock.advance(2000);
    client.last.onUp();
    client.last.onDown("boom");
    expect(clock.scheduled.at(-1)).toBe(5000);
    clock.advance(5000);

    expect(client.streams.length).toBe(4);
    expect(health).toEqual([true, false, true, false, true, false]);
    poker.stop();
  });

  test("a drop just before the stable window keeps the next backoff step", () => {
    const { client, clock, poker } = makePoker({ backoffMs: [1000, 2000, 5000] });
    poker.start();
    client.last.onUp();
    client.last.onDown("boom");
    clock.advance(1000);
    client.last.onUp();
    clock.advance(STABLE_MS - 1);
    client.last.onDown("too soon");
    expect(clock.scheduled.at(-1)).toBe(2000);
    poker.stop();
  });

  test("resets to the first delay after 30 seconds of stable health", () => {
    const { client, clock, poker } = makePoker({ backoffMs: [1000, 2000, 5000] });
    poker.start();
    client.last.onUp();
    client.last.onDown("boom");
    clock.advance(1000);
    client.last.onUp();
    clock.advance(STABLE_MS);
    client.last.onDown("stable drop");
    expect(clock.scheduled.at(-1)).toBe(1000);
    poker.stop();
  });

  test("logs one reconnect per distinct delay, including only one at the ceiling", () => {
    const { client, clock, poker } = makePoker({ backoffMs: [1000, 2000, 5000] });
    const lines = capturingLog(() => {
      poker.start();
      client.last.onUp();
      for (const delay of [1000, 2000, 5000, 5000]) {
        client.last.onDown("boom");
        clock.advance(delay);
        client.last.onUp();
      }
    });
    expect(lines.filter((line) => line.includes("reconnecting in"))).toEqual([
      "[events] reconnecting in 1000ms",
      "[events] reconnecting in 2000ms",
      "[events] reconnecting in 5000ms",
    ]);
    poker.stop();
  });
});

describe("EventPoker — resubscribe on pane-set change", () => {
  test("reconnects with the new scoped subscriptions and skips a no-op set", () => {
    const { client, poker } = makePoker();
    poker.start();
    client.last.onUp();
    poker.setAgentPanes(["w1:p1"]);
    expect(client.streams.length).toBe(2);
    expect(client.streams[0]!.closed).toBe(true);
    expect(
      client.last.subscriptions.some((s) => s.type === "pane.agent_status_changed" && s.pane_id === "w1:p1"),
    ).toBe(true);
    poker.setAgentPanes(["w1:p1"]);
    expect(client.streams.length).toBe(2);
    poker.stop();
  });
});

describe("EventPoker — stop()", () => {
  test("closes the stream, cancels a pending reconnect, and never reconnects afterward", () => {
    const { client, clock, poker } = makePoker({ backoffMs: [10] });
    poker.start();
    client.last.onUp();
    client.last.onDown("boom");
    poker.stop();
    clock.advance(30);
    expect(client.streams.length).toBe(1);
  });

  test("closing an up stream on stop() does not flip health or schedule work", () => {
    const { client, clock, poker, health } = makePoker();
    poker.start();
    client.last.onUp();
    poker.stop();
    expect(client.last.closed).toBe(true);
    expect(health).toEqual([true]);
    clock.advance(20);
    expect(client.streams.length).toBe(1);
  });
});
