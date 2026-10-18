import { resolve } from "node:path";

/**
 * T25 diff-renderer spike switch (docs/specs/t3/README.md "Diff renderer spike"). `diffs-adapter` is the
 * module the `DiffCodeView` seam lazy-loads. Unset, it is `status` (today's lines) and the build is
 * untouched; `SIGHTR_DIFFS=hand|pierre` aliases it to that candidate and adds the `spike-diffs.html`
 * measurement page. The candidates' packages are not in package.json; to measure, install them unsaved:
 *   bun add -d --no-save @pierre/diffs@1.5.2                      (A)
 *   bun add -d --no-save highlight.js@11.12.0                     (B)
 * `tsconfig.json` excludes pierre.tsx, hand.tsx and hand.highlight.ts so a normal typecheck and build never need them.
 */
export const DIFF_ADAPTERS = ["status", "hand", "pierre"] as const;
export type DiffAdapterName = (typeof DIFF_ADAPTERS)[number];

export function diffsAdapter(env: Record<string, string | undefined> = process.env): DiffAdapterName {
  const raw = env.SIGHTR_DIFFS?.trim();
  if (!raw) return "status";
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
