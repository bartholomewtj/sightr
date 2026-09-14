import { describe, expect, test } from "bun:test";
import {
  createPaneQueue,
  paneKey,
  PaneBusyError,
  PANE_QUEUE_TIMEOUT_MS,
} from "./pane-queue.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("PaneQueue", () => {
  test("runs on a free key and returns the value", async () => {
    const queue = createPaneQueue(50);
    await expect(queue.run("p", async () => 42)).resolves.toBe(42);
  });

  test("serialises runs on one key", async () => {
    const queue = createPaneQueue(100);
    const log: string[] = [];
    const run = (n: number) => queue.run("p", async () => {
      log.push(`start:${n}`);
      await sleep(5);
      log.push(`end:${n}`);
    });
    await Promise.all([run(1), run(2)]);
    expect(log).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  test("different keys run concurrently", async () => {
    const queue = createPaneQueue(100);
    const log: string[] = [];
    await Promise.all([
      queue.run("a", async () => { log.push("start:a"); await sleep(10); log.push("end:a"); }),
      queue.run("b", async () => { log.push("start:b"); await sleep(10); log.push("end:b"); }),
    ]);
    expect(log.slice(0, 2)).toEqual(["start:a", "start:b"]);
  });

  test("a rejecting run releases the lock", async () => {
    const queue = createPaneQueue(100);
    const first = queue.run("p", async () => { throw new Error("no"); });
    await expect(first).rejects.toThrow("no");
    await expect(queue.run("p", async () => "ok")).resolves.toBe("ok");
  });

  test("a timed-out waiter never runs", async () => {
    const queue = createPaneQueue(10);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run("p", () => held);
    let ran = false;
    await expect(queue.run("p", async () => { ran = true; })).rejects.toBeInstanceOf(PaneBusyError);
    release();
    await first;
    await sleep(1);
    expect(ran).toBe(false);
  });

  test("a timeout does not strand the queue", async () => {
    const queue = createPaneQueue(10);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run("p", () => held);
    await expect(queue.run("p", async () => {})).rejects.toBeInstanceOf(PaneBusyError);
    release();
    await first;
    await expect(queue.run("p", async () => "third")).resolves.toBe("third");
    expect(queue.size()).toBe(0);
  });

  test("pane keys are the pane id", () => {
    expect(paneKey("p1")).toBe("p1");
    expect(paneKey("p1")).not.toBe(paneKey("p2"));
  });

  test("uses a ten second default timeout", () => {
    expect(PANE_QUEUE_TIMEOUT_MS).toBe(10_000);
  });
});
