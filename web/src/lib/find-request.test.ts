import { describe, expect, it, vi } from "vitest";
import { onFindOpenRequest, requestFindOpen } from "./find-request";

describe("find request", () => {
  it("does not throw with no subscribers", () => { expect(() => requestFindOpen()).not.toThrow(); });
  it("notifies subscribers and unsubscribes", () => {
    const first = vi.fn(); const second = vi.fn();
    const off = onFindOpenRequest(first); onFindOpenRequest(second);
    requestFindOpen();
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
    off(); requestFindOpen(); expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledTimes(2);
  });
});
