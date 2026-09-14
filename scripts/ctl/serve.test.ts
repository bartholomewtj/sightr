import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";
import { CtlError, type Run } from "./types.ts";
import { formatHandlerRecord, parseHandlerRecord, rootAvailability, serve, stopServe } from "./serve.ts";

const secret = "super-secret-signing-key";
type TsState = { status: any; calls: string[] };

function fakeTs(state: TsState, opts: { versionCode?: number; bgCode?: number } = {}): Run {
  return async (cmd, args) => {
    if (cmd !== "tailscale") return { code: 127, stdout: "", stderr: "" };
    state.calls.push(args.join(" "));
    if (args[0] === "version") return { code: opts.versionCode ?? 0, stdout: "1", stderr: "" };
    if (args[0] === "status" && args[1] === "--json") {
      return { code: 0, stdout: JSON.stringify({ Self: { DNSName: "host.example.", TailscaleIPs: ["100.64.0.1", "fd7a::1"] } }), stderr: "" };
    }
    if (args[0] === "serve" && args.includes("status") && args.includes("--json")) {
      return { code: 0, stdout: JSON.stringify(state.status), stderr: "" };
    }
    if (args[0] === "serve" && args.includes("--bg")) {
      if ((opts.bgCode ?? 0) !== 0) return { code: opts.bgCode ?? 1, stdout: "serve failed", stderr: "" };
      const port = args[args.length - 1]!;
      const http = args.find((a) => a.startsWith("--http="));
      const listener = http ? http.slice("--http=".length) : "443";
      const protocol = http ? "HTTP" : "HTTPS";
      state.status = { TCP: { [listener]: { [protocol]: true } }, Web: { [`host.example:${listener}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } };
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "serve" && args.includes("off")) {
      state.status = {};
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 2, stdout: "", stderr: "" };
  };
}

async function cfg() {
  const dir = await mkdtemp(path.join(tmpdir(), "sightr-"));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ".env"), `SIGHTR_VAPID_PRIVATE=${secret}\n`);
  return dir;
}
const record = (dir: string) => path.join(dir, "tailscale-managed-handler");

test("parseHandlerRecord refuses the three malformed shapes", () => {
  expect(parseHandlerRecord("http:bad|x|y")).toEqual({ error: "error: invalid managed Tailscale handler state: http:bad|x|y" });
  expect(parseHandlerRecord("http:8787|host.example:9999|http://127.0.0.1:8787")).toEqual({ error: "error: managed Tailscale HostPort does not match its listener: http:8787|host.example:9999|http://127.0.0.1:8787" });
  expect(parseHandlerRecord("http:8787|host.example:8787|http://example")).toEqual({ error: "error: invalid managed Tailscale proxy target: http:8787|host.example:8787|http://example" });
});

test("HTTP port cutover rewrites the ownership record", async () => {
  const dir = await cfg();
  const state: TsState = { status: {}, calls: [] };
  const env = { HERDR_PLUGIN_CONFIG_DIR: dir, SIGHTR_SERVE_MODE: "http", SIGHTR_PORT: "8787" };
  expect(await serve(env, fakeTs(state))).toBe(0);
  expect((await readFile(record(dir), "utf8")).trim()).toBe("http:8787|host.example:8787|http://127.0.0.1:8787");
  env.SIGHTR_PORT = "9999";
  expect(await serve(env, fakeTs(state))).toBe(0);
  expect((await readFile(record(dir), "utf8")).trim()).toBe("http:9999|host.example:9999|http://127.0.0.1:9999");
});

test("SIGHTR_SKIP_SERVE=1 removes the managed mapping", async () => {
  const dir = await cfg();
  const state: TsState = { status: {}, calls: [] };
  const run = fakeTs(state);
  await serve({ HERDR_PLUGIN_CONFIG_DIR: dir, SIGHTR_SERVE_MODE: "http", SIGHTR_PORT: "8787" }, run);
  expect(await serve({ HERDR_PLUGIN_CONFIG_DIR: dir, SIGHTR_SKIP_SERVE: "1", SIGHTR_PORT: "8787" }, run)).toBe(0);
  await expect(access(record(dir))).rejects.toThrow();
  expect(state.calls.some((c) => c.includes("off"))).toBe(true);
});

test("foreign root and protocol mismatch refuse without creating a record", async () => {
  const dir = await cfg();
  const foreign = { TCP: { "8787": { HTTP: true } }, Web: { "host.example:8787": { Handlers: { "/": { Proxy: "http://127.0.0.1:7000" } } } } };
  const state: TsState = { status: foreign, calls: [] };
  await expect(serve({ HERDR_PLUGIN_CONFIG_DIR: dir, SIGHTR_SERVE_MODE: "http", SIGHTR_PORT: "8787" }, fakeTs(state))).rejects.toThrow(/unowned root mount/);
  await expect(access(record(dir))).rejects.toThrow();
  expect(state.status).toEqual(foreign);

  const httpsSibling = { TCP: { "8787": { HTTPS: true } }, Web: { "host.example:8787": { Handlers: { "/other": { Proxy: "http://127.0.0.1:7002" } } } } };
  const httpsState: TsState = { status: httpsSibling, calls: [] };
  await expect(serve({ HERDR_PLUGIN_CONFIG_DIR: dir, SIGHTR_SERVE_MODE: "http", SIGHTR_PORT: "8787" }, fakeTs(httpsState))).rejects.toThrow(/opposite listener protocol/);
  expect(httpsState.status).toEqual(httpsSibling);

  const http443 = { TCP: { "443": { HTTP: true } }, Web: { "host.example:443": { Handlers: { "/other": { Proxy: "http://127.0.0.1:7003" } } } } };
  const httpState: TsState = { status: http443, calls: [] };
  await expect(serve({ HERDR_PLUGIN_CONFIG_DIR: dir, SIGHTR_PORT: "8787" }, fakeTs(httpState))).rejects.toThrow(/opposite listener protocol/);
  await expect(access(record(dir))).rejects.toThrow();
});

test("replaced-from-under-us keeps the ownership record", async () => {
  const dir = await cfg();
  const state: TsState = { status: {}, calls: [] };
  await serve({ HERDR_PLUGIN_CONFIG_DIR: dir, SIGHTR_SERVE_MODE: "http", SIGHTR_PORT: "8787" }, fakeTs(state));
  const owned = (await readFile(record(dir), "utf8")).trim();
  state.status = { TCP: { "8787": { HTTPS: true } }, Web: { "host.example:8787": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } };
  await expect(serve({ HERDR_PLUGIN_CONFIG_DIR: dir, SIGHTR_SKIP_SERVE: "1", SIGHTR_PORT: "8787" }, fakeTs(state))).rejects.toThrow(/replaced/);
  expect((await readFile(record(dir), "utf8")).trim()).toBe(owned);
  state.status = { TCP: { "8787": { HTTP: true } }, Web: { "host.example:8787": { Handlers: { "/": { Proxy: "http://127.0.0.1:7001" } } } } };
  await expect(serve({ HERDR_PLUGIN_CONFIG_DIR: dir, SIGHTR_SKIP_SERVE: "1", SIGHTR_PORT: "8787" }, fakeTs(state))).rejects.toThrow(/replaced/);
  expect((await readFile(record(dir), "utf8")).trim()).toBe(owned);
});

test("missing tailscale CLI fails serve without printing open:", async () => {
  const dir = await cfg();
  const logs: string[] = [];
  const orig = console.log; const err = console.error;
  console.log = (...a) => { logs.push(a.join(" ")); };
  console.error = (...a) => { logs.push(a.join(" ")); };
  try {
    await expect(serve({ HERDR_PLUGIN_CONFIG_DIR: dir }, async () => ({ code: 127, stdout: "", stderr: "" }))).rejects.toThrow(/tailscale not found/);
  } finally { console.log = orig; console.error = err; }
  expect(logs.join("\n")).not.toContain("open:");
});

test("failed publish returns 1 and does not leave a record", async () => {
  const dir = await cfg();
  const state: TsState = { status: {}, calls: [] };
  expect(await serve({ HERDR_PLUGIN_CONFIG_DIR: dir, SIGHTR_SERVE_MODE: "http", SIGHTR_PORT: "8787" }, fakeTs(state, { bgCode: 1 }))).toBe(1);
  await expect(access(record(dir))).rejects.toThrow();
});

test("io.remove throwing keeps the record on absent and after a successful off", async () => {
  const dir = await cfg();
  await writeFile(record(dir), formatHandlerRecord({ mode: "http", port: "8787", hostPort: "host.example:8787", proxy: "http://127.0.0.1:8787" }));
  const boom = { remove: async () => { throw new Error("no"); } };
  await expect(stopServe({ configDir: dir }, {}, async () => ({ code: 0, stdout: "{}", stderr: "" }), boom)).rejects.toBeInstanceOf(CtlError);
  expect((await readFile(record(dir), "utf8")).length).toBeGreaterThan(0);
  await expect(stopServe({ configDir: dir }, {}, async () => ({
    code: 0,
    stdout: JSON.stringify({ TCP: { "8787": { HTTP: true } }, Web: { "host.example:8787": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } }),
    stderr: "",
  }), boom)).rejects.toBeInstanceOf(CtlError);
  expect((await readFile(record(dir), "utf8")).length).toBeGreaterThan(0);
});

test("adopts a preexisting own root and refuses a foreign proxy", async () => {
  const dir = await cfg();
  const ownHttp = { TCP: { "8787": { HTTP: true } }, Web: { "host.example:8787": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } };
  const state: TsState = { status: ownHttp, calls: [] };
  expect(await serve({ HERDR_PLUGIN_CONFIG_DIR: dir, SIGHTR_SERVE_MODE: "http", SIGHTR_PORT: "8787" }, fakeTs(state))).toBe(0);
  expect((await readFile(record(dir), "utf8")).trim()).toBe("http:8787|host.example:8787|http://127.0.0.1:8787");

  const dir2 = await cfg();
  const ownHttps = { TCP: { "443": { HTTPS: true } }, Web: { "host.example:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } };
  const httpsState: TsState = { status: ownHttps, calls: [] };
  expect(await serve({ HERDR_PLUGIN_CONFIG_DIR: dir2, SIGHTR_PORT: "8787" }, fakeTs(httpsState))).toBe(0);
  expect((await readFile(record(dir2), "utf8")).trim()).toBe("https:443|host.example:443|http://127.0.0.1:8787");

  expect(rootAvailability({ TCP: { "8787": { HTTP: true } }, Web: { "host.example:8787": { Handlers: { "/": { Proxy: "http://127.0.0.1:7000" } } } } }, "8787", "http", "http://127.0.0.1:8787")).toBe("occupied");
});
