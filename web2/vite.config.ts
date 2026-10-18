import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { diffsAlias, diffsInputs } from "./diffs-spike.ts";
import { t3Aliases } from "./t3-shims.ts";
import { v1Scope } from "./v1-scope.ts";

// web2 is the front door at `/` since the T15 cutover; v1 moved to `/v1/`. `SIGHTR_WEB2_BASE` (e.g.
// `/v2/`) overrides the base for a `vite dev` preview only: the bridge serves a `/` build and redirects
// `/v2/...` to `/...`. In `vite dev`, proxy /api to the bridge like web/ does.
const BASE = process.env.SIGHTR_WEB2_BASE ?? "/";
const BRIDGE = process.env.SIGHTR_DEV_TARGET ?? "http://127.0.0.1:8787";
const devHosts = (process.env.SIGHTR_DEV_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);
const allowedHosts = devHosts.includes("*") ? true : devHosts.length > 0 ? devHosts : undefined;

// React Compiler (T23 spike, docs/specs/t3/README.md): off by default. `SIGHTR_COMPILER=1` builds web2
// through babel-plugin-react-compiler, the way @vitejs/plugin-react 6 documents it. It was measured and
// not adopted, so its dev dependencies are not in package.json; to measure again, install them unsaved:
//   bun add -d --no-save @rolldown/plugin-babel @babel/core@^7.29.0 babel-plugin-react-compiler@1.0.0
// (Babel 8 mis-lowers destructuring defaults in compiler 1.0.0; keep @babel/core on 7.)
async function reactCompiler(): Promise<Plugin[]> {
  if (process.env.SIGHTR_COMPILER !== "1") return [];
  const load = (name: string) => import(/* @vite-ignore */ name) as Promise<Record<string, any>>;
  try {
    const [{ default: babel }, { reactCompilerPreset }] = await Promise.all([
      load("@rolldown/plugin-babel"),
      load("@vitejs/plugin-react"),
    ]);
    return [babel({ presets: [reactCompilerPreset()] }) as Plugin];
  } catch (e) {
    throw new Error(`SIGHTR_COMPILER=1 needs the compiler's dev dependencies (see vite.config.ts): ${(e as Error).message}`);
  }
}

// Build stamp, the same scheme as web/vite.config.ts: baked into the bundle as __BUILD_INFO__ and
// emitted to dist/build-info.json, which the bridge reads off disk for X-Sightr-Build on web2's responses.
const git = (cmd: string) =>
  execSync(cmd, { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();

function gitSha(): string {
  let sha: string;
  try {
    sha = git("git rev-parse --short HEAD") || "nogit";
  } catch {
    return "nogit";
  }
  let dirty = false;
  try {
    dirty = git("git status --porcelain").length > 0;
  } catch {
    /* keep the sha, just no dirty marker */
  }
  return dirty ? `${sha}-dirty` : sha;
}
function isReleaseBuild(version: string): boolean {
  try {
    return git(`git rev-parse -q --verify "refs/tags/v${version}^{commit}"`) === git("git rev-parse HEAD");
  } catch {
    return true;
  }
}
const pkgVersion = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as { version: string }
).version;
const buildSha = gitSha();
const buildTime = new Date().toISOString();
const stampedVersion = isReleaseBuild(pkgVersion) ? pkgVersion : `${pkgVersion}-dev`;
const BUILD_INFO = {
  version: stampedVersion,
  sha: buildSha,
  time: buildTime,
  id: `${stampedVersion}+${buildSha}.${Math.floor(Date.parse(buildTime) / 1000)}`,
};

const buildInfoPlugin: Plugin = {
  name: "sightr-build-info",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "build-info.json", source: JSON.stringify(BUILD_INFO, null, 2) });
  },
};

export default defineConfig({
  base: BASE,
  define: { __BUILD_INFO__: JSON.stringify(BUILD_INFO) },
  plugins: [
    v1Scope({ web2Src: resolve(import.meta.dirname, "src"), v1Src: resolve(import.meta.dirname, "../web/src") }),
    // File routes under src/routes, generated into src/routeTree.gen.ts (T3's layout). Before react().
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    ...(await reactCompiler()),
    tailwindcss(),
    buildInfoPlugin,
    VitePWA({
      // Hand-written SW (src/sw.ts) for the push handlers, as in web/. Registered from lib/pwa.ts.
      injectRegister: false,
      registerType: "autoUpdate",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts", // -> dist/sw.js, served at /sw.js with Service-Worker-Allowed: / (v1's old URL)
      includeAssets: ["favicon.svg", "favicon.ico", "favicon-96x96.png", "apple-touch-icon.png"],
      manifest: {
        // The id, scope and start URL v1's manifest had, so an installed Sightr is the same app and
        // updates in place (T15). v1's manifest moved to /v1/.
        name: "Sightr",
        short_name: "Sightr",
        description: "Monitor and reply to your Herdr agent herd",
        id: BASE,
        start_url: BASE,
        scope: BASE,
        display: "standalone",
        orientation: "any",
        background_color: "#171b21",
        theme_color: "#171b21",
        icons: [
          { src: `${BASE}web-app-manifest-192x192.png`, sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: `${BASE}web-app-manifest-512x512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      injectManifest: { globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"] },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    // `@/` is resolved by v1Scope above, not here (see v1-scope.ts).
    alias: [
      { find: "@shared", replacement: resolve(import.meta.dirname, "../shared") },
      { find: "@v1", replacement: resolve(import.meta.dirname, "../web/src") },
      // The diff seam's adapter (T25 spike, T27). Unset: the `hand` renderer. SIGHTR_DIFFS=status|hand|pierre: a candidate, and the measurement page.
      diffsAlias(import.meta.dirname),
      ...t3Aliases(import.meta.dirname),
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    // SIGHTR_DIFFS also builds spike-diffs.html, the page that renders the fixtures and prints timings.
    rollupOptions: { input: diffsInputs(import.meta.dirname) },
  },
  server: {
    port: 5174,
    allowedHosts,
    proxy: { "/api": { target: BRIDGE, changeOrigin: true } },
  },
});
