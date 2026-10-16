import { describe, expect, it } from "vitest";

import { resolveCustomSnooze, resolveSnoozePresets, snoozeWakeDescription, snoozeWakeLabel, toDateTimeLocal } from "./Sidebar.snooze";

const HOUR = 60 * 60 * 1_000;

describe("snooze presets", () => {
  it("offers 1 h, 3 h, this evening, tomorrow 08:00 and next week", () => {
    const now = new Date(2026, 9, 14, 10, 15); // a Wednesday morning
    const presets = resolveSnoozePresets(now);
    expect(presets.map((p) => p.id)).toEqual(["hour", "three-hours", "evening", "tomorrow", "next-week"]);
    expect(presets[0]!.snoozedUntil).toBe(now.getTime() + HOUR);
    expect(presets[1]!.snoozedUntil).toBe(now.getTime() + 3 * HOUR);
    expect(new Date(presets[3]!.snoozedUntil)).toEqual(new Date(2026, 9, 15, 8, 0));
    expect(new Date(presets[4]!.snoozedUntil)).toEqual(new Date(2026, 9, 19, 8, 0)); // Monday
  });

  it("drops this evening within the hour before it, and next week when it is tomorrow", () => {
    const sunday = new Date(2026, 9, 18, 17, 30);
    expect(resolveSnoozePresets(sunday).map((p) => p.id)).toEqual(["hour", "three-hours", "tomorrow"]);
  });
});

describe("custom snooze", () => {
  const now = new Date(2026, 9, 14, 10, 0);
  it("reads a datetime-local value in the future", () => {
    expect(resolveCustomSnooze("2026-10-14T12:30", now)).toBe(new Date(2026, 9, 14, 12, 30).getTime());
    expect(resolveCustomSnooze(toDateTimeLocal(now.getTime() + HOUR), now)).toBe(now.getTime() + HOUR);
  });
  it("refuses the past, garbage and rolled-over dates", () => {
    expect(resolveCustomSnooze("2026-10-14T09:00", now)).toBeNull();
    expect(resolveCustomSnooze("tomorrow", now)).toBeNull();
    expect(resolveCustomSnooze("2026-02-31T08:00", now)).toBeNull();
  });
});

describe("wake labels", () => {
  it("counts down in m, h, d", () => {
    expect(snoozeWakeLabel(1_000, 2_000)).toBe("now");
    expect(snoozeWakeLabel(10 * 60_000, 0)).toBe("10m");
    expect(snoozeWakeLabel(5 * HOUR, 0)).toBe("5h");
    expect(snoozeWakeLabel(50 * HOUR, 0)).toBe("3d");
  });
  it("describes the wake day", () => {
    const now = new Date(2026, 9, 14, 10, 0);
    expect(snoozeWakeDescription(new Date(2026, 9, 15, 8, 0).getTime(), now)).toMatch(/^tomorrow /);
  });
});
