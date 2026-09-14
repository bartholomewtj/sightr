import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Spied at the api seam, not over the network: the invariant under test is how MANY times the
// store asks, and a mock records that synchronously — no waiting on a request that may never come.
vi.mock("@/lib/api", () => ({ fetchConfig: vi.fn() }));

import type { BridgeConfig } from "@/lib/types";

// The store is module state with no reset hook, so every case gets a fresh copy of the module. The
// mocked api is re-imported with it so `asked` is the spy the fresh store actually calls.
let oc: typeof import("./operator-commands");
let asked: ReturnType<typeof vi.mocked<typeof import("@/lib/api")["fetchConfig"]>>;

beforeEach(async () => {
  vi.resetModules();
  asked = vi.mocked((await import("@/lib/api")).fetchConfig);
  asked.mockReset();
  oc = await import("./operator-commands");
});

const forkIn = {
  agent: "pi",
  command: "/fork-in-herdr",
  description: "Fork into a new herdr tab",
  takesArg: false,
  argHint: "",
};

const config = (
  operatorCommands?: BridgeConfig["operatorCommands"],
  operatorWheel?: BridgeConfig["operatorWheel"],
): BridgeConfig => ({
  push: false,
  vapidPublicKey: "",
  ...(operatorCommands ? { operatorCommands } : {}),
  ...(operatorWheel ? { operatorWheel } : {}),
});

describe("the operator's palette rows are read once, not polled", () => {
  it("fetches on the first mount and serves later mounts from module state", async () => {
    asked.mockResolvedValue(config([forkIn]));
    const first = renderHook(() => oc.useOperatorCommands());
    await waitFor(() => expect(first.result.current).toEqual([forkIn]));
    first.unmount();
    const second = renderHook(() => oc.useOperatorCommands());
    expect(second.result.current).toEqual([forkIn]); // no second round trip, no flash of empty
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("does not re-request when the composer re-renders around it", async () => {
    asked.mockResolvedValue(config([forkIn]));
    const { result, rerender } = renderHook(() => oc.useOperatorCommands());
    await waitFor(() => expect(result.current).toEqual([forkIn]));
    for (let i = 0; i < 20; i++) rerender();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("survives a refusal as an empty list, retried on a later mount, not on every render", async () => {
    // Extras are additive: with none, the palette is exactly what a user without the var sees. So a
    // read-only device or an auth lapse costs an empty list and nothing else — and, critically, the
    // composer re-renders on every 1.5s snapshot, so a kick in the render body would turn one
    // refusal into a request per tick, forever.
    asked.mockRejectedValue(new Error("403"));
    const { result, rerender } = renderHook(() => oc.useOperatorCommands());
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 20; i++) rerender();
    expect(result.current).toEqual([]);
    expect(asked).toHaveBeenCalledTimes(1); // the failure did not arm a request loop
    expect(oc.getOperatorCommands()).toEqual([]);

    asked.mockResolvedValue(config([forkIn]));
    const retry = renderHook(() => oc.useOperatorCommands()); // a later mount is the retry
    await waitFor(() => expect(retry.result.current).toEqual([forkIn]));
  });

  it("shares one in-flight request between concurrent callers", async () => {
    // All three land before the first response resolves, so the second and third must join the
    // promise already in flight rather than opening their own.
    asked.mockResolvedValue(config([forkIn]));
    const all = Promise.all([
      oc.loadOperatorCommands(),
      oc.loadOperatorCommands(),
      oc.loadOperatorCommands(),
    ]);
    expect(asked).toHaveBeenCalledTimes(1);
    await all;
    expect(oc.getOperatorCommands()).toEqual([forkIn]);
  });

  it("treats a bridge that sends no operatorCommands as no extras", async () => {
    asked.mockResolvedValue(config());
    await oc.loadOperatorCommands();
    expect(oc.getOperatorCommands()).toEqual([]);
  });

  it("serves operatorWheel through useOperatorWheel", async () => {
    const wheelRow = { label: "Esc", keys: ["Escape"] };
    asked.mockResolvedValue(config([], [wheelRow]));
    const { result } = renderHook(() => oc.useOperatorWheel());
    await waitFor(() => expect(result.current).toEqual([wheelRow]));
  });
});
