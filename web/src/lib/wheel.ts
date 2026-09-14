import { CONTROL_PRESETS, type CtrlDef } from "@/lib/operator-keys";
import type { OperatorWheelRow } from "@/lib/types";

export type WheelSlice =
  | { kind: "keys"; label: string; keys: string[] }
  | { kind: "type"; label: string };

export const SHIPPED_WHEEL: readonly WheelSlice[] = [
  { kind: "keys", label: "Esc", keys: ["Escape"] },
  { kind: "keys", label: "Tab", keys: ["Tab"] },
  { kind: "keys", label: "Enter", keys: ["Enter"] },
  { kind: "type", label: "Type" },
];

/** One pickable wheel slice: a stable id plus the slice it produces. */
export interface WheelChoice {
  id: string;
  slice: WheelSlice;
  label: string;
}

/** Stable identity for a slice: what Settings stores and the composer looks up. */
export function sliceId(slice: WheelSlice): string {
  return slice.kind === "type" ? "type" : `keys:${slice.keys.join("+")}`;
}

/** Everything the operator may put on the wheel: the built-ins first, then the Keys
 *  dock's preset catalog. Deduped by id, first wins. */
export function wheelChoices(presets: readonly CtrlDef[] = CONTROL_PRESETS): readonly WheelChoice[] {
  const choices: WheelChoice[] = [];
  const seen = new Set<string>();

  for (const slice of SHIPPED_WHEEL) {
    const id = sliceId(slice);
    if (!seen.has(id)) {
      seen.add(id);
      choices.push({ id, slice, label: slice.label });
    }
  }

  for (const preset of presets) {
    if (!preset.keys || preset.keys.length === 0) continue;
    const slice: WheelSlice = {
      kind: "keys",
      label: preset.label,
      keys: preset.keys,
    };
    const id = sliceId(slice);
    if (!seen.has(id)) {
      seen.add(id);
      choices.push({ id, slice, label: slice.label });
    }
  }

  return choices;
}

export const MAX_SLICES = 6;
export const HOLD_MS = 180;
export const DEAD_ZONE_PX = 28;

export const ARC_DEG = 90;
export const ARC_START = 180;
export const SLICE_PX = 44;
export const GAP_PX = 6;
export const MIN_RADIUS = 96;

function round1(val: number): number {
  const r = Math.round(val * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

export interface SlicePoint {
  index: number;
  angleDeg: number;
  dx: number;
  dy: number;
  radius: number;
}

export function layoutSlices(count: number): SlicePoint[] {
  if (count <= 0) return [];
  if (count === 1) {
    const angleDeg = 135;
    const radius = MIN_RADIUS;
    const rad = (angleDeg * Math.PI) / 180;
    const dx = round1(radius * Math.cos(rad));
    const dy = round1(-radius * Math.sin(rad));
    return [{ index: 0, angleDeg, dx, dy, radius }];
  }
  const step = ARC_DEG / (count - 1);
  const stepRad = (step * Math.PI) / 180;
  const radius = Math.max(MIN_RADIUS, (SLICE_PX + GAP_PX) / (2 * Math.sin(stepRad / 2)));
  const roundedRadius = round1(radius);

  const points: SlicePoint[] = [];
  for (let i = 0; i < count; i++) {
    const angleDeg = round1(ARC_START - i * step);
    const rad = (angleDeg * Math.PI) / 180;
    const dx = round1(radius * Math.cos(rad));
    const dy = round1(-radius * Math.sin(rad));
    points.push({ index: i, angleDeg, dx, dy, radius: roundedRadius });
  }
  return points;
}

export type WheelPick =
  | { kind: "dead" }
  | { kind: "away" }
  | { kind: "slice"; index: number };

export function pickSlice(dx: number, dy: number, count: number): WheelPick {
  if (count <= 0) return { kind: "away" };
  const dist = Math.hypot(dx, dy);
  if (dist < DEAD_ZONE_PX) return { kind: "dead" };

  const step = count <= 1 ? ARC_DEG : ARC_DEG / (count - 1);
  const stepRad = (step * Math.PI) / 180;
  const radius = count <= 1
    ? MIN_RADIUS
    : Math.max(MIN_RADIUS, (SLICE_PX + GAP_PX) / (2 * Math.sin(stepRad / 2)));

  if (dist > radius + SLICE_PX) return { kind: "away" };

  // Screen coordinates: +y is DOWN, so -dy is upwards math y.
  let angle = Math.atan2(-dy, dx) * (180 / Math.PI);
  if (angle < -90) {
    angle += 360;
  }

  const slack = Math.max(step / 2, 20);
  if (angle < 90 - slack || angle > 180 + slack) {
    return { kind: "away" };
  }

  if (count === 1) {
    return { kind: "slice", index: 0 };
  }

  let bestIndex = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < count; i++) {
    const sliceAngle = ARC_START - i * step;
    const diff = Math.abs(angle - sliceAngle);
    if (diff < bestDiff - 1e-6) {
      bestDiff = diff;
      bestIndex = i;
    }
  }

  return { kind: "slice", index: bestIndex };
}

/** Slices for this pane. Precedence: this device's picks > keys.toml [[wheel]] rows >
 *  SHIPPED_WHEEL. */
export function wheelSlicesFor(
  mine: readonly OperatorWheelRow[],
  picked?: readonly string[],
  presets?: readonly CtrlDef[],
): readonly WheelSlice[] {
  if (picked && picked.length > 0) {
    const catalog = wheelChoices(presets);
    const pickedSet = new Set(picked);
    const matched: WheelSlice[] = [];
    for (const choice of catalog) {
      if (pickedSet.has(choice.id)) {
        matched.push(choice.slice);
        if (matched.length >= MAX_SLICES) break;
      }
    }
    if (matched.length > 0) {
      return matched;
    }
  }

  if (!mine || mine.length === 0) {
    return SHIPPED_WHEEL;
  }
  const out: WheelSlice[] = [];
  for (const row of mine) {
    if (out.length >= MAX_SLICES) break;
    if (row.action === "type") {
      out.push({ kind: "type", label: row.label });
    } else if (Array.isArray(row.keys) && row.keys.length > 0) {
      out.push({ kind: "keys", label: row.label, keys: row.keys });
    }
  }
  return out;
}

export function shortLabel(key: string): string {
  switch (key.toLowerCase()) {
    case "escape":
      return "Esc";
    case "enter":
      return "⏎";
    case "tab":
      return "⇥";
    default:
      return key;
  }
}
