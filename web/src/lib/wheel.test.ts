import { describe, expect, it } from "vitest";

import {
  layoutSlices,
  pickSlice,
  shortLabel,
  sliceId,
  wheelChoices,
  wheelSlicesFor,
  SHIPPED_WHEEL,
} from "./wheel";
import type { CtrlDef } from "@/lib/operator-keys";
import type { OperatorWheelRow } from "@/lib/types";

describe("layoutSlices", () => {
  it("keeps every button inside 390x844 viewport for 1 to 6 slices and buttons >= 48px apart", () => {
    const handleX = 358;
    const handleY = 700;
    const buttonRadius = 22; // 44px diameter

    for (let count = 1; count <= 6; count++) {
      const points = layoutSlices(count);
      expect(points).toHaveLength(count);

      for (const pt of points) {
        const cx = handleX + pt.dx;
        const cy = handleY + pt.dy;

        // Bounding box of 44px button
        const left = cx - buttonRadius;
        const right = cx + buttonRadius;
        const top = cy - buttonRadius;
        const bottom = cy + buttonRadius;

        expect(left).toBeGreaterThan(0);
        expect(right).toBeLessThan(390);
        expect(top).toBeGreaterThan(0);
        expect(bottom).toBeLessThan(844);
      }

      // Check distance between any two centres
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          const dist = Math.hypot(
            points[i]!.dx - points[j]!.dx,
            points[i]!.dy - points[j]!.dy,
          );
          expect(dist).toBeGreaterThanOrEqual(48);
        }
      }
    }
  });

  it("gives 30° steps from 180° to 90° for count 4, and single 135° slice for count 1", () => {
    const p4 = layoutSlices(4);
    expect(p4.map((p) => p.angleDeg)).toEqual([180, 150, 120, 90]);

    const p1 = layoutSlices(1);
    expect(p1).toHaveLength(1);
    expect(p1[0]!.angleDeg).toBe(135);
  });
});

describe("pickSlice", () => {
  it("resolves (0,0) and a 20px drag to dead", () => {
    expect(pickSlice(0, 0, 4)).toEqual({ kind: "dead" });
    expect(pickSlice(-20, 0, 4)).toEqual({ kind: "dead" });
    expect(pickSlice(0, -20, 4)).toEqual({ kind: "dead" });
  });

  it("resolves a 400px drag to away", () => {
    expect(pickSlice(-400, 0, 4)).toEqual({ kind: "away" });
    expect(pickSlice(0, -400, 4)).toEqual({ kind: "away" });
  });

  it("resolves straight down to away", () => {
    expect(pickSlice(0, 100, 4)).toEqual({ kind: "away" });
  });

  it("resolves exactly on a slice angle to that index", () => {
    const points = layoutSlices(4);
    for (let i = 0; i < points.length; i++) {
      const pt = points[i]!;
      expect(pickSlice(pt.dx, pt.dy, 4)).toEqual({ kind: "slice", index: i });
    }
  });

  it("resolves a boundary angle halfway between two slices to the nearer/lower index", () => {
    // Slices at 180, 150, 120, 90. Halfway between 180 and 150 is 165°.
    // dx = 100 * cos(165°), dy = -100 * sin(165°)
    const rad = (165 * Math.PI) / 180;
    const dx = 100 * Math.cos(rad);
    const dy = -100 * Math.sin(rad);
    expect(pickSlice(dx, dy, 4)).toEqual({ kind: "slice", index: 0 });
  });

  it("picks on a slice bearing even at half the radius", () => {
    const pt = layoutSlices(4)[2]!; // 120°
    const halfDx = pt.dx / 2;
    const halfDy = pt.dy / 2;
    expect(pickSlice(halfDx, halfDy, 4)).toEqual({ kind: "slice", index: 2 });
  });
});

describe("wheelSlicesFor", () => {
  it("returns the shipped four slices when mine is empty", () => {
    expect(wheelSlicesFor([])).toEqual(SHIPPED_WHEEL);
  });

  it("returns three operator rows when provided", () => {
    const rows: OperatorWheelRow[] = [
      { label: "A", keys: ["a"] },
      { label: "B", keys: ["b"] },
      { label: "Type", action: "type" },
    ];
    expect(wheelSlicesFor(rows)).toEqual([
      { kind: "keys", label: "A", keys: ["a"] },
      { kind: "keys", label: "B", keys: ["b"] },
      { kind: "type", label: "Type" },
    ]);
  });

  it("drops a seventh row", () => {
    const rows: OperatorWheelRow[] = Array.from({ length: 7 }, (_, i) => ({
      label: `S${i + 1}`,
      keys: ["x"],
    }));
    const slices = wheelSlicesFor(rows);
    expect(slices).toHaveLength(6);
    expect(slices.map((s) => s.label)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
  });

  it("drops an unusable row", () => {
    const rows: OperatorWheelRow[] = [
      { label: "Good", keys: ["Enter"] },
      { label: "Bad" },
      { label: "EmptyKeys", keys: [] },
    ];
    expect(wheelSlicesFor(rows)).toEqual([
      { kind: "keys", label: "Good", keys: ["Enter"] },
    ]);
  });
});

describe("shortLabel", () => {
  it("maps Escape, Enter, Tab to short symbols and preserves others", () => {
    expect(shortLabel("Escape")).toBe("Esc");
    expect(shortLabel("Enter")).toBe("⏎");
    expect(shortLabel("Tab")).toBe("⇥");
    expect(shortLabel("ctrl+c")).toBe("ctrl+c");
  });
});

describe("sliceId", () => {
  it("returns 'type' for the Type slice and 'keys:ctrl+c' for a chord", () => {
    expect(sliceId({ kind: "type", label: "Type" })).toBe("type");
    expect(sliceId({ kind: "keys", label: "Ctrl C", keys: ["ctrl+c"] })).toBe("keys:ctrl+c");
  });
});

describe("wheelChoices", () => {
  it("lists the four built-ins then the six shipped presets — ten in total", () => {
    const choices = wheelChoices();
    expect(choices).toHaveLength(10);
    expect(choices.map((c) => c.id)).toEqual([
      "keys:Escape",
      "keys:Tab",
      "keys:Enter",
      "type",
      "keys:ctrl+c",
      "keys:ctrl+d",
      "keys:ctrl+u",
      "keys:ctrl+r",
      "keys:ctrl+l",
      "keys:ctrl+z",
    ]);
  });

  it("with an operator preset spelled ['Escape'] does not add a second Esc", () => {
    const customPresets: CtrlDef[] = [
      { label: "My Esc", keys: ["Escape"] },
      { label: "Custom", keys: ["ctrl+a"] },
    ];
    const choices = wheelChoices(customPresets);
    expect(choices).toHaveLength(5);
    expect(choices.filter((c) => c.id === "keys:Escape")).toHaveLength(1);
    expect(choices.find((c) => c.id === "keys:Escape")?.slice.label).toBe("Esc");
    expect(choices.some((c) => c.id === "keys:ctrl+a")).toBe(true);
  });
});

describe("wheelSlicesFor with picks", () => {
  const rows: OperatorWheelRow[] = [
    { label: "Toml1", keys: ["a"] },
    { label: "Toml2", keys: ["b"] },
  ];

  it("returns only the picked slices, in catalog order, even when the picks were stored in a different order", () => {
    const picks = ["keys:Enter", "keys:Escape"];
    const slices = wheelSlicesFor(rows, picks);
    expect(slices).toEqual([
      { kind: "keys", label: "Esc", keys: ["Escape"] },
      { kind: "keys", label: "Enter", keys: ["Enter"] },
    ]);
  });

  it("an unknown pick id is skipped; picks that all miss fall back to the [[wheel]] rows", () => {
    expect(wheelSlicesFor(rows, ["unknown-id"])).toEqual([
      { kind: "keys", label: "Toml1", keys: ["a"] },
      { kind: "keys", label: "Toml2", keys: ["b"] },
    ]);

    const mixed = wheelSlicesFor(rows, ["unknown-id", "keys:Tab"]);
    expect(mixed).toEqual([{ kind: "keys", label: "Tab", keys: ["Tab"] }]);
  });

  it("picks beat [[wheel]] rows; empty picks leave existing behaviour intact", () => {
    const picked = wheelSlicesFor(rows, ["keys:ctrl+c"]);
    expect(picked).toEqual([
      { kind: "keys", label: "Ctrl C", keys: ["ctrl+c"] },
    ]);

    expect(wheelSlicesFor(rows, [])).toEqual([
      { kind: "keys", label: "Toml1", keys: ["a"] },
      { kind: "keys", label: "Toml2", keys: ["b"] },
    ]);
  });

  it("seven picks resolve to six slices", () => {
    const allPicks = [
      "keys:Escape",
      "keys:Tab",
      "keys:Enter",
      "type",
      "keys:ctrl+c",
      "keys:ctrl+d",
      "keys:ctrl+u",
    ];
    const slices = wheelSlicesFor(rows, allPicks);
    expect(slices).toHaveLength(6);
    expect(slices.map((s) => s.label)).toEqual([
      "Esc",
      "Tab",
      "Enter",
      "Type",
      "Ctrl C",
      "Ctrl D",
    ]);
  });
});
