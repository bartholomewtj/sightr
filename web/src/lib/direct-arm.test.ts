import { afterEach, describe, expect, it } from "vitest";
import { onArmToggleRequest, requestArmToggle, __resetDirectArm, isDirectArmed, setDirectArmed } from "./direct-arm";

// Folded from direct-arm.test.ts.
describe('direct-arm.test', () => {
  afterEach(() => { /* subscribers are removed by each test */ });

  describe("direct arm signal", () => {
    it("is safe without subscribers", () => { expect(() => requestArmToggle()).not.toThrow(); });
    it("notifies each subscriber once", () => {
      const one = vi.fn(); const two = vi.fn();
      const offOne = onArmToggleRequest(one); const offTwo = onArmToggleRequest(two);
      requestArmToggle();
      expect(one).toHaveBeenCalledTimes(1); expect(two).toHaveBeenCalledTimes(1);
      offOne(); offTwo();
    });
    it("supports unsubscribe", () => {
      const listener = vi.fn();
      const off = onArmToggleRequest(listener); off(); requestArmToggle();
      expect(listener).not.toHaveBeenCalled();
    });
  });
});

// Folded from direct-arm-state.test.ts.
describe('direct-arm-state.test', () => {
  afterEach(__resetDirectArm);
  describe("direct arm state", () => {
    it("is false by default and tracks changes", () => { expect(isDirectArmed()).toBe(false); setDirectArmed(true); expect(isDirectArmed()).toBe(true); setDirectArmed(false); expect(isDirectArmed()).toBe(false); });
    it("resets", () => { setDirectArmed(true); __resetDirectArm(); expect(isDirectArmed()).toBe(false); });
  });
});
