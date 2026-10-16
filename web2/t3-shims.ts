import { resolve } from "node:path";

/**
 * T3 Code module specifiers that resolve to a stand-in under `src/t3/shims/` (README "Adapting T3
 * components": seams, not forks). An adopted T3 file keeps its upstream import; the alias points it at
 * the shim. Vite and Vitest read this table; `tsconfig.json` `paths` must list the same entries (a test
 * checks that they agree).
 */
export const T3_SHIMS: Record<string, string> = {
  "~/lib/windowControlsOverlay": "src/t3/shims/windowControlsOverlay.ts",
};

/** Vite `resolve.alias` entries: every shim first, then T3's own `~/` root (which is web2's `src`). */
export function t3Aliases(root: string): { find: string | RegExp; replacement: string }[] {
  return [
    ...Object.entries(T3_SHIMS).map(([find, file]) => ({ find, replacement: resolve(root, file) })),
    { find: /^~\//, replacement: `${resolve(root, "src").split("\\").join("/")}/` },
  ];
}
