import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import {
  BUILD_HEADER,
  buildId,
  buildIdFor,
  __clearStaticGzipCache,
  RETIRE_WORKER_JS,
  serveStatic,
  staticTree,
  UI_HEADER,
  type StaticDirs,
} from "./static-assets.ts";

// Two built trees on disk: web2 at `/`, v1 at `/v1/` (docs/specs/t3/T15-cutover.md).
let root = "";
let dirs: StaticDirs;
const cfg = { publicHosts: [] } as unknown as Config;
const rollback = { publicHosts: [], ui: "v1" } as unknown as Config;

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

const get = (path: string, d: StaticDirs = dirs, c: Config = cfg, search = "") => serveStatic(path, "localhost", c, d, search);
const getEnc = (path: string, accept: string | null, d: StaticDirs = dirs, c: Config = cfg) =>
  serveStatic(path, "localhost", c, d, "", accept);

describe("staticTree", () => {
  test("splits /v1 off and strips the prefix; everything else is web2's", () => {
    expect(staticTree("/v1")).toEqual({ tree: "web", pathname: "/" });
    expect(staticTree("/v1/")).toEqual({ tree: "web", pathname: "/" });
    expect(staticTree("/v1/pane/p1")).toEqual({ tree: "web", pathname: "/pane/p1" });
    expect(staticTree("/v1x")).toEqual({ tree: "web2", pathname: "/v1x" });
    expect(staticTree("/")).toEqual({ tree: "web2", pathname: "/" });
    expect(staticTree("/thread/x")).toEqual({ tree: "web2", pathname: "/thread/x" });
  });

  test("/v2 (the preview address) redirects to the same path under /, query kept", () => {
    expect(staticTree("/v2")).toEqual({ redirect: "/" });
    expect(staticTree("/v2/")).toEqual({ redirect: "/" });
    expect(staticTree("/v2/thread/x", "v2", "?a=1")).toEqual({ redirect: "/thread/x?a=1" });
    expect(staticTree("/v2x")).toEqual({ tree: "web2", pathname: "/v2x" });
  });

  test("SIGHTR_UI=v1 sends navigations to /v1/ and retires /sw.js", () => {
    expect(staticTree("/", "v1")).toEqual({ redirect: "/v1/" });
    expect(staticTree("/thread/x", "v1")).toEqual({ redirect: "/v1/" });
    expect(staticTree("/pane/p1", "v1", "?x=1")).toEqual({ redirect: "/v1/pane/p1?x=1" });
    expect(staticTree("/files/a/b", "v1")).toEqual({ redirect: "/v1/files/a/b" });
    expect(staticTree("/settings", "v1")).toEqual({ redirect: "/v1/settings" });
    expect(staticTree("/v2/settings", "v1")).toEqual({ redirect: "/v1/settings" });
    expect(staticTree("/v1/pane/p1", "v1")).toEqual({ tree: "web", pathname: "/pane/p1" });
    expect(staticTree("/sw.js", "v1")).toEqual({ retireWorker: true });
    expect(staticTree("/assets/a.js", "v1")).toEqual({ tree: "web2", pathname: "/assets/a.js" });
  });
});

describe("serveStatic: web2 at /", () => {
  test("/ and a deep link return web2's index.html", async () => {
    for (const path of ["/", "/thread/x", "/pane/w1:p1", "/settings"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>v2</title>");
      expect(res.headers.get("content-security-policy")).toBeTruthy();
    }
  });

  test("hashed web2 assets are immutable-cached", async () => {
    const res = await get("/assets/a.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("v2");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("/sw.js is web2's worker with v1's old scope, never cached", async () => {
    const res = await get("/sw.js");
    expect(await res.text()).toContain("v2 sw");
    expect(res.headers.get("service-worker-allowed")).toBe("/");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("/v2/... redirects (302) to the same path under /", async () => {
    const res = await get("/v2/thread/x", dirs, cfg, "?after=3");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/thread/x?after=3");
    expect((await get("/v2")).headers.get("location")).toBe("/");
  });

  test("a missing web2 build answers 503 with a hint, and v1 is unaffected", async () => {
    const missing = { web: dirs.web, web2: join(root, "nope") };
    const res = await get("/thread/x", missing);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("frontend not built");
    expect((await get("/v1/", missing)).status).toBe(200);
  });

  test("a missing web2 asset is a 404, not the shell", async () => {
    expect((await get("/assets/missing.js")).status).toBe(404);
  });
});

describe("serveStatic: v1 at /v1/", () => {
  test("index and deep link return v1's index.html", async () => {
    for (const path of ["/v1", "/v1/", "/v1/pane/p1", "/v1/files/a/b"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>v1</title>");
    }
  });

  test("v1 assets are immutable-cached; its worker may control /v1/ only", async () => {
    const asset = await get("/v1/assets/a.js");
    expect(await asset.text()).toContain("v1");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const sw = await get("/v1/sw.js");
    expect(await sw.text()).toContain("v1 sw");
    expect(sw.headers.get("service-worker-allowed")).toBe("/v1/");
  });

  test("a path that climbs out of web/dist is refused", async () => {
    expect((await get("/v1/../../web2/dist/x")).status).toBe(403);
  });

  test("a missing v1 build answers 503 with its own hint", async () => {
    const res = await get("/v1/pane/p1", { web: join(root, "nope"), web2: dirs.web2 });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("v1 not built");
  });
});

describe("build ids per UI", () => {
  test("X-Sightr-Build on static files names the tree that served them", async () => {
    expect((await get("/")).headers.get(BUILD_HEADER)).toBe("v2-build");
    expect((await get("/v1/")).headers.get(BUILD_HEADER)).toBe("v1-build");
    expect(await buildId(dirs.web2)).toBe("v2-build");
  });

  test("an API request with x-sightr-ui: v1 gets v1's id; anything else gets web2's", async () => {
    const v1 = new Request("http://x/api/snapshot", { headers: { [UI_HEADER]: "v1" } });
    const plain = new Request("http://x/api/snapshot");
    const other = new Request("http://x/api/snapshot", { headers: { [UI_HEADER]: "v2" } });
    expect(await buildIdFor(v1, dirs)).toBe("v1-build");
    expect(await buildIdFor(plain, dirs)).toBe("v2-build");
    expect(await buildIdFor(other, dirs)).toBe("v2-build");
  });

  test("build-info.json stays private in both trees", async () => {
    expect((await get("/build-info.json")).status).toBe(404);
    expect((await get("/v1/build-info.json")).status).toBe(404);
  });
});

describe("SIGHTR_UI=v1 rollback", () => {
  test("/ redirects to /v1/ and /v1/ serves v1", async () => {
    const res = await get("/", dirs, rollback);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/v1/");
    expect(await (await get("/v1/", dirs, rollback)).text()).toContain("<title>v1</title>");
    expect((await get("/pane/p1", dirs, rollback)).headers.get("location")).toBe("/v1/pane/p1");
  });

  test("/sw.js retires web2's worker; its assets stay readable", async () => {
    const sw = await get("/sw.js", dirs, rollback);
    expect(sw.status).toBe(200);
    expect(await sw.text()).toBe(RETIRE_WORKER_JS);
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    expect(RETIRE_WORKER_JS).toContain("unregister()");
    expect(RETIRE_WORKER_JS).not.toContain("fetch");
    expect((await get("/assets/a.js", dirs, rollback)).status).toBe(200);
  });
});

describe("static gzip", () => {
  // A dist tree is text-heavy; served raw a cold thread open pulled ~1.7 MB. Big enough to clear the
  // threshold, and the same bytes every run so the body check is exact.
  const big = 'console.log("a chunk of compressible javascript");\n'.repeat(120);

  beforeAll(() => {
    writeFileSync(join(dirs.web2, "assets", "big.js"), big);
    writeFileSync(join(dirs.web2, "assets", "small.js"), "x");
    writeFileSync(join(dirs.web2, "assets", "pic.png"), "x".repeat(4000));
    __clearStaticGzipCache();
  });

  test("gzips a compressible asset when the client accepts gzip", async () => {
    const res = await getEnc("/assets/big.js", "gzip, br");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("accept-encoding");
    // The immutable cache header and the build stamp survive compression.
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get(BUILD_HEADER)).toBe("v2-build");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(Bun.gunzipSync(body))).toBe(big);
  });

  test("leaves the same asset uncompressed without the header, still varying", async () => {
    const res = await getEnc("/assets/big.js", null);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(await res.text()).toBe(big);
  });

  test("does not gzip a type that is already compressed", async () => {
    const res = await getEnc("/assets/pic.png", "gzip");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(4000);
  });

  test("does not gzip below the threshold", async () => {
    const res = await getEnc("/assets/small.js", "gzip");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(await res.text()).toBe("x");
  });

  test("a gzipped asset is memoised, not re-zipped per request", async () => {
    const first = new Uint8Array(await (await getEnc("/assets/big.js", "gzip")).arrayBuffer());
    const second = new Uint8Array(await (await getEnc("/assets/big.js", "gzip")).arrayBuffer());
    expect(second).toEqual(first);
  });
});
