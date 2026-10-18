import { resolve } from "node:path";

/**
 * T25 diff-renderer spike switch (docs/specs/t3/README.md "Diff renderer spike"). `diffs-adapter` is the
 * module the `DiffCodeView` seam lazy-loads. Unset, it is `hand` (T25's decision, flipped by T27) and the
 * build has no measurement page; `SIGHTR_DIFFS=status|hand|pierre` aliases it to that candidate and adds the
 * `spike-diffs.html` measurement page. highlight.js (B) is a dependency since T27; A's package is not, so to
 * measure it install it unsaved:
 *   bun add -d --no-save @pierre/diffs@1.5.2                      (A)
 * `tsconfig.json` excludes pierre.tsx so a normal typecheck and build never need it.
 */
export const DIFF_ADAPTERS = ["status", "hand", "pierre"] as const;
export type DiffAdapterName = (typeof DIFF_ADAPTERS)[number];

export function diffsAdapter(env: Record<string, string | undefined> = process.env): DiffAdapterName {
  const raw = env.SIGHTR_DIFFS?.trim();
  if (!raw) return "hand";
  if ((DIFF_ADAPTERS as readonly string[]).includes(raw)) return raw as DiffAdapterName;
  throw new Error(`SIGHTR_DIFFS must be status, hand or pierre (or unset), got "${raw}"`);
}

/** Vite `resolve.alias` entry for the seam's `diffs-adapter` import. */
export function diffsAlias(root: string, env: Record<string, string | undefined> = process.env): { find: string | RegExp; replacement: string } {
  return { find: /^diffs-adapter$/, replacement: resolve(root, "src/components/diffs/adapters", `${diffsAdapter(env)}.tsx`).split("\\").join("/") };
}

/**
 * Extra build inputs: only a flagged build gets the measurement page. `SIGHTR_DIFFS_PAGE=0` leaves it out,
 * for a size measurement whose entry chunks must match an unflagged build's (the page shares chunks with the app).
 */
export function diffsInputs(root: string, env: Record<string, string | undefined> = process.env): Record<string, string> | undefined {
  diffsAdapter(env); // throws on a bad value
  if (!env.SIGHTR_DIFFS?.trim() || env.SIGHTR_DIFFS_PAGE?.trim() === "0") return undefined;
  return { main: resolve(root, "index.html"), "spike-diffs": resolve(root, "spike-diffs.html") };
}
