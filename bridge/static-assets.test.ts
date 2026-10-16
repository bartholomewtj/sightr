import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { BUILD_HEADER, buildId, serveStatic, staticTree, type StaticDirs } from "./static-assets.ts";

// Two built trees on disk: v1 at `/`, web2 at `/v2/` (docs/specs/t3/T09-web2-shell.md).
let root = "";
let dirs: StaticDirs;
const cfg = { publicHosts: [] } as unknown as Config;

function tree(dir: string, label: string, id: string) {
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>${label}</title>`);
  writeFileSync(join(dir, "assets", "a.js"), `console.log("${label}")`);
  writeFileSync(join(dir, "sw.js"), `// ${label} sw`);
  writeFileSync(join(dir, "build-info.json"), JSON.stringify({ id }));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sightr-static-"));
  dirs = { web: join(root, "web", "dist"), web2: join(root, "web2", "dist") };
  tree(dirs.web, "v1", "v1-build");
  tree(dirs.web2, "v2", "v2-build");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const get = (path: string, d: StaticDirs = dirs) => serveStatic(path, "localhost", cfg, d);

describe("staticTree", () => {
  test("splits /v2 off and strips the prefix", () => {
    expect(staticTree("/v2")).toEqual({ v2: true, pathname: "/" });
    expect(staticTree("/v2/")).toEqual({ v2: true, pathname: "/" });
    expect(staticTree("/v2/thread/x")).toEqual({ v2: true, pathname: "/thread/x" });
    expect(staticTree("/v2x")).toEqual({ v2: false, pathname: "/v2x" });
    expect(staticTree("/pane/v2")).toEqual({ v2: false, pathname: "/pane/v2" });
  });
});

describe("serveStatic /v2/", () => {
  test("/v2/ and a deep link return web2's index.html", async () => {
    for (const path of ["/v2", "/v2/", "/v2/thread/x"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>v2</title>");
      expect(res.headers.get("content-security-policy")).toBeTruthy();
    }
  });

  test("hashed web2 assets are immutable-cached", async () => {
    const res = await get("/v2/assets/a.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("v2");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("a path that climbs out of web2/dist is refused", async () => {
    expect((await get("/v2/../web/dist/x")).status).toBe(403);
    expect((await get("/v2/../../web/dist/index.html")).status).toBe(403);
  });

  test("web2's service worker may control /v2/ only", async () => {
    const res = await get("/v2/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("service-worker-allowed")).toBe("/v2/");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("build-info.json stays private", async () => {
    expect((await get("/v2/build-info.json")).status).toBe(404);
    expect((await get("/build-info.json")).status).toBe(404);
  });

  test("X-Sightr-Build names the tree that served the response", async () => {
    expect((await get("/v2/")).headers.get(BUILD_HEADER)).toBe("v2-build");
    expect((await get("/")).headers.get(BUILD_HEADER)).toBe("v1-build");
    expect(await buildId(dirs.web2)).toBe("v2-build");
  });

  test("a missing web2 build answers 503 with a hint, and v1 is unaffected", async () => {
    const missing = { web: dirs.web, web2: join(root, "nope") };
    const res = await get("/v2/thread/x", missing);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("web2 not built");
    expect((await get("/", missing)).status).toBe(200);
  });

  test("a missing web2 asset is a 404, not the shell", async () => {
    expect((await get("/v2/assets/missing.js")).status).toBe(404);
  });
});

describe("serveStatic / still serves v1", () => {
  test("index, deep link and sw.js", async () => {
    const index = await get("/");
    expect(await index.text()).toContain("<title>v1</title>");
    expect(await (await get("/pane/w1:p1")).text()).toContain("<title>v1</title>");
    // A path that merely starts with "v2" is v1's.
    expect(await (await get("/v2x")).text()).toContain("<title>v1</title>");
    expect((await get("/sw.js")).headers.get("service-worker-allowed")).toBe("/");
  });
});
