// Sightr code (T28). When the Diff panel may offer split view. Split is for a wide column only: each side
// needs about 320 px (44 monospace columns at 12 px), so the diff column must be 640 px, and once split it
// stays until the column drops below 624 px (no flicker while the panel is dragged across the line).

/** The viewport rule (`useLayout() === "desktop"`, 1024 px) and the column rule, together. */
export const SPLIT_MIN_COLUMN_PX = 640;
/** Once available, split stays available down to this width. */
export const SPLIT_KEEP_COLUMN_PX = 624;

export function splitAvailable(args: { layout: "desktop" | "phone"; columnPx: number; wasSplit: boolean }): boolean {
  const { layout, columnPx, wasSplit } = args;
  if (layout !== "desktop") return false;
  return columnPx >= (wasSplit ? SPLIT_KEEP_COLUMN_PX : SPLIT_MIN_COLUMN_PX);
}

/**
 * The layout actually drawn: the stored choice where split is available, stacked everywhere else. The stored
 * choice is never rewritten by a width change, so widening the column brings split back.
 */
export function effectiveDiffLayout(pref: "stacked" | "split", available: boolean): "stacked" | "split" {
  return available && pref === "split" ? "split" : "stacked";
}
