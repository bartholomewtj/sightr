import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { t3Aliases } from "./t3-shims.ts";
import { v1Scope } from "./v1-scope.ts";

// web2 is served by the bridge at /v2/ beside v1 (docs/specs/t3/T09-web2-shell.md) until cutover (T15).
// In `vite dev`, proxy /api to the bridge like web/ does.
const BRIDGE = process.env.SIGHTR_DEV_TARGET ?? "http://127.0.0.1:8787";
const devHosts = (process.env.SIGHTR_DEV_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);
const allowedHosts = devHosts.includes("*") ? true : devHosts.length > 0 ? devHosts : undefined;

// Build stamp, the same scheme as web/vite.config.ts: baked into the bundle as __BUILD_INFO__ and
// emitted to dist/build-info.json, which the bridge reads off disk for X-Sightr-Build on /v2/ responses.
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
  base: "/v2/",
  define: { __BUILD_INFO__: JSON.stringify(BUILD_INFO) },
  plugins: [
    v1Scope({ web2Src: resolve(import.meta.dirname, "src"), v1Src: resolve(import.meta.dirname, "../web/src") }),
    // File routes under src/routes, generated into src/routeTree.gen.ts (T3's layout). Before react().
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    buildInfoPlugin,
    VitePWA({
      // Hand-written SW (src/sw.ts) for the push handlers, as in web/. Registered from lib/pwa.ts.
      injectRegister: false,
      registerType: "autoUpdate",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts", // -> dist/sw.js, served at /v2/sw.js with Service-Worker-Allowed: /v2/
      includeAssets: ["favicon.svg", "favicon.ico", "favicon-96x96.png", "apple-touch-icon.png"],
      manifest: {
        // A separate install from v1: its own id and scope.
        name: "Sightr v2",
        short_name: "Sightr v2",
        description: "Monitor and reply to your Herdr agent herd",
        id: "/v2/",
        start_url: "/v2/",
        scope: "/v2/",
        display: "standalone",
        orientation: "any",
        background_color: "#171b21",
        theme_color: "#171b21",
        icons: [
          { src: "/v2/web-app-manifest-192x192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/v2/web-app-manifest-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
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
      ...t3Aliases(import.meta.dirname),
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5174,
    allowedHosts,
    proxy: { "/api": { target: BRIDGE, changeOrigin: true } },
  },
});
