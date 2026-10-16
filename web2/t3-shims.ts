import { resolve } from "node:path";

/**
 * T3 Code module specifiers that resolve to a stand-in under `src/t3/shims/` (README "Adapting T3
 * components": seams, not forks). An adopted T3 file keeps its upstream import; the alias points it at
 * the shim. Vite and Vitest read this table; `tsconfig.json` `paths` must list the same entries (a test
 * checks that they agree).
 */
export const T3_SHIMS: Record<string, string> = {
  "~/lib/windowControlsOverlay": "src/t3/shims/windowControlsOverlay.ts",
  // T11: T3 package modules the adopted timeline logic imports (adapted ports or stand-ins).
  "@t3tools/client-runtime/work-log/presentation": "src/t3/client-runtime/work-log/presentation.ts",
  "@t3tools/client-runtime/work-log/command-label": "src/t3/shims/commandLabel.ts",
  "@t3tools/shared/orchestrationTiming": "src/t3/shared/orchestrationTiming.ts",
  "@t3tools/shared/toolActivity": "src/t3/shared/toolActivity.ts",
  "@t3tools/shared/toolOutput": "src/t3/shims/toolOutput.ts",
  // T12: the composer's dispatch-mode rule and the slash menu's ranking (verbatim ports).
  "@t3tools/client-runtime/state/composer-dispatch": "src/t3/client-runtime/state/composerDispatch.ts",
  "@t3tools/shared/searchRanking": "src/t3/shared/searchRanking.ts",
  // T13: the keybinding table and its `when` grammar (contracts adapted, shared parser verbatim).
  "@t3tools/contracts": "src/t3/contracts/index.ts",
  "@t3tools/shared/keybindings": "src/t3/shared/keybindings.ts",
};

/** Vite `resolve.alias` entries: every shim first, then T3's own `~/` root (which is web2's `src`). */
export function t3Aliases(root: string): { find: string | RegExp; replacement: string }[] {
  return [
    ...Object.entries(T3_SHIMS).map(([find, file]) => ({ find, replacement: resolve(root, file) })),
    { find: /^~\//, replacement: `${resolve(root, "src").split("\\").join("/")}/` },
  ];
}
