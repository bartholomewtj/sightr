import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { resolve } from "node:path";

import { diffsAlias } from "./diffs-spike.ts";
import { t3Aliases } from "./t3-shims.ts";
import { v1Scope } from "./v1-scope.ts";

// No PWA or Tailwind plugins under Vitest. jsdom + Testing Library + MSW + a fake EventSource cover the
// shell, the stream client and the command client.
export default defineConfig({
  define: {
    __BUILD_INFO__: JSON.stringify({ version: "0.0.0-test", sha: "test", time: "1970-01-01T00:00:00.000Z", id: "test" }),
  },
  plugins: [
    v1Scope({ web2Src: resolve(import.meta.dirname, "src"), v1Src: resolve(import.meta.dirname, "../web/src") }),
    tanstackRouter({ target: "react", autoCodeSplitting: false }),
    react(),
  ],
  resolve: {
    alias: [
      // highlight.js is not a dependency (T25), so the hand adapter's tests run against a stand-in. The jsdom
      // harness (SIGHTR_SPIKE_ADAPTER) measures the real package.
      ...(process.env.SIGHTR_SPIKE_ADAPTER
        ? []
        : [
            { find: /^highlight\.js\/lib\/core$/, replacement: resolve(import.meta.dirname, "src/test/highlight-js-stub/core.ts") },
            { find: /^highlight\.js\/lib\/languages\/.+$/, replacement: resolve(import.meta.dirname, "src/test/highlight-js-stub/language.ts") },
          ]),
      { find: "@shared", replacement: resolve(import.meta.dirname, "../shared") },
      { find: "@v1", replacement: resolve(import.meta.dirname, "../web/src") },
      { find: "virtual:pwa-register", replacement: resolve(import.meta.dirname, "src/test/pwa-register-stub.ts") },
      diffsAlias(import.meta.dirname),
      ...t3Aliases(import.meta.dirname),
    ],
  },
  test: {
    // The suite renders the app under the pre-cutover preview base, `/v2/` (import.meta.env.BASE_URL):
    // the code reads its base from vite (router basepath, worker URL), so this also proves nothing is
    // pinned to the production base `/`.
    env: { BASE_URL: "/v2/" },
    environment: "jsdom",
    globals: true,
    css: false,
    // The T25 jsdom harness counts React commits through the DevTools hook, which must exist before react-dom loads.
    setupFiles: [...(process.env.SIGHTR_SPIKE_ADAPTER ? ["./src/components/diffs/spike/hook.ts"] : []), "./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}", "*.test.ts"],
  },
});
