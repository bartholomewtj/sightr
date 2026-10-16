import { isAbsolute, join, relative, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * `@/` means two trees in web2. web2's own files use it for `web2/src`. A few v1 lib files web2 imports
 * through `@v1` (`agent-commands.ts`, `operator-scope.ts`, `operator-keys.ts`, `wheel.ts`) also use
 * `@/lib/...`, and for them it must stay `web/src`. A plain alias cannot tell the two apart, so this
 * resolver looks at the importer: under `../web/src` → v1's tree, anywhere else → web2's.
 *
 * `@` is therefore NOT in `resolve.alias` (Vite's alias step runs before every plugin and would
 * rewrite `@/` before this sees it). TypeScript gets the same answer from `tsconfig.json` `paths`,
 * which tries `./src/*` first and `../web/src/*` second.
 */
export interface ScopeDirs {
  web2Src: string;
  v1Src: string;
}

const norm = (p: string) => resolve(p).split("\\").join("/").toLowerCase();

/** True when `file` sits inside `dir`. */
export function isUnder(file: string, dir: string): boolean {
  const rel = relative(norm(dir), norm(file.split("?")[0] ?? file));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The path an `@/x` specifier stands for, given who imports it. null when it is not an `@/` import. */
export function scopedTarget(source: string, importer: string | undefined, dirs: ScopeDirs): string | null {
  if (!source.startsWith("@/")) return null;
  const base = importer && isUnder(importer, dirs.v1Src) ? dirs.v1Src : dirs.web2Src;
  return join(base, source.slice(2));
}

export function v1Scope(dirs: ScopeDirs): Plugin {
  return {
    name: "sightr-v1-scope",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const target = scopedTarget(source, importer, dirs);
      if (target === null) return null;
      return this.resolve(target, importer, { ...options, skipSelf: true });
    },
  };
}
