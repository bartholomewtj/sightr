import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COMMAND_TYPES,
  THREAD_EVENT_TYPES,
  THREAD_STATUS_RANK,
  worstStatus,
  type CommandType,
  type ThreadEventType,
  type ThreadStatus,
  type TurnItemType,
} from "../../shared/v2/contracts.ts";

// Compile-time exhaustiveness: each list names every member of its union, and nothing else.
type Missing<Union, List extends readonly unknown[]> = Exclude<Union, List[number]>;
type AssertNever<T extends never> = T;
export type CommandListComplete = AssertNever<Missing<CommandType, typeof COMMAND_TYPES>>;
export type EventListComplete = AssertNever<Missing<ThreadEventType, typeof THREAD_EVENT_TYPES>>;

const TURN_ITEM_TYPES = [
  "user_message",
  "assistant_message",
  "reasoning",
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "approval_request",
  "user_input_request",
  "system_notice",
  "error",
  "session",
  "screen",
] as const satisfies readonly TurnItemType[];
export type TurnItemListComplete = AssertNever<Missing<TurnItemType, typeof TURN_ITEM_TYPES>>;

describe("contracts", () => {
  test("worstStatus orders approval > input > failed > working > done > idle > starting", () => {
    const order: ThreadStatus[] = ["approval", "input", "failed", "working", "done", "idle", "starting"];
    expect([...order].sort((a, b) => THREAD_STATUS_RANK[a] - THREAD_STATUS_RANK[b])).toEqual(order);
    for (let i = 0; i < order.length; i++) {
      expect(worstStatus(order.slice(i).reverse())).toBe(order[i]!);
    }
    expect(worstStatus([])).toBe("idle");
    expect(worstStatus(["starting"])).toBe("starting");
    expect(worstStatus(["starting", "idle"])).toBe("idle");
  });

  test("every command and event name in the T01 spec is in the lists", () => {
    expect(new Set(COMMAND_TYPES).size).toBe(COMMAND_TYPES.length);
    expect(new Set(THREAD_EVENT_TYPES).size).toBe(THREAD_EVENT_TYPES.length);
    expect<string[]>([...COMMAND_TYPES].sort()).toEqual(
      [
        "thread.create", "thread.rename", "thread.pin", "thread.unpin", "thread.snooze", "thread.settle",
        "thread.unsettle", "thread.archive", "thread.unarchive", "thread.markRead", "thread.markUnread",
        "message.dispatch", "queued.reorder", "queued.edit", "queued.cancel", "queue.resume", "run.interrupt",
        "runtime-request.respond", "thread.permissionMode.set", "thread.model.set", "project.create", "project.rename",
      ].sort(),
    );
    expect<string[]>([...THREAD_EVENT_TYPES].sort()).toEqual(
      [
        "project.upserted", "project.closed", "thread.created", "thread.updated", "thread.shelf-changed",
        "thread.archived", "run.started", "run.ended", "turn-item.updated", "runtime-request.updated",
        "queue.updated", "command.rejected", "dispatch.failed", "thread.create.failed",
      ].sort(),
    );
  });

  test("shared/v2/contracts.ts imports nothing", () => {
    const source = readFileSync(join(import.meta.dir, "../../shared/v2/contracts.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});
