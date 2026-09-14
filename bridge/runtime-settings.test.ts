import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeSettingsStore, resetRuntimeSettings, validateSettingsPatch, settingsRoute } from "./runtime-settings.ts";
import type { Config } from "./config.ts";

// Stores are process-global by design; always reset them so tests cannot affect other bridge tests.
const dirs: string[] = [];
const cfg = (stateDir: string): Config => ({ stateDir, deviceAllowlist: ["phone"], notifyDelayMs: 30000, submitKeys: ["Enter"], readLines: 200 } as Config);
afterEach(async () => { resetRuntimeSettings(); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function temp() { const d = await mkdtemp(join(process.env.TEMP ?? process.env.TMPDIR ?? ".", "sightr-settings-")); dirs.push(d); return d; }

describe("RuntimeSettingsStore", () => {
  test("uses env defaults and overlays only changed values", async () => {
    const d = await temp(); const c = cfg(d); const s = new RuntimeSettingsStore(c);
    expect(s.current()).toEqual({ deviceAllowlist: ["phone"], notifyDelayMs: 30000, submitKeys: ["Enter"], readLines: 200 });
    await s.set({ readLines: 400 });
    expect(s.current().readLines).toBe(400);
    expect(JSON.parse(await readFile(join(d, "settings.json"), "utf8"))).toEqual({ readLines: 400 });
  });
  test("loads partial and corrupt files safely", async () => {
    const d = await temp(); await Bun.write(join(d, "settings.json"), JSON.stringify({ notifyDelayMs: 5, readLines: "lots", submitKeys: [1] }));
    const s = new RuntimeSettingsStore(cfg(d)); await s.load(); expect(s.current().notifyDelayMs).toBe(5); expect(s.current().readLines).toBe(200); expect(s.current().submitKeys).toEqual(["Enter"]);
    await Bun.write(join(d, "settings.json"), "not json"); await s.load(); expect(s.current().notifyDelayMs).toBe(30000);
  });
  test("reloads an overlay and leaves no temporary file", async () => {
    const d = await temp(); const s = new RuntimeSettingsStore(cfg(d)); await s.set({ readLines: 400 });
    const fresh = new RuntimeSettingsStore(cfg(d)); await fresh.load(); expect(fresh.current().readLines).toBe(400);
    expect(await Bun.file(join(d, "settings.json.tmp")).exists()).toBe(false);
  });
});

describe("settings validation and route", () => {
  test("validates and normalises patches", () => {
    expect(validateSettingsPatch({ deviceAllowlist: [" phone ", "phone"], submitKeys: ["enter"] })).toEqual({ ok: true, patch: { deviceAllowlist: ["phone"], submitKeys: ["Enter"] } });
    expect(validateSettingsPatch({ deviceAllowlist: [] }).ok).toBe(true);
    expect(validateSettingsPatch({ deviceAllowlist: [" "] }).ok).toBe(false);
    expect(validateSettingsPatch({ deviceAllowlist: ["x".repeat(65)] }).ok).toBe(false);
    expect(validateSettingsPatch({ deviceAllowlist: Array.from({ length: 65 }, (_, i) => String(i)) }).ok).toBe(false);
    expect(validateSettingsPatch({ deviceAllowlist: [1] }).ok).toBe(false);
    for (const n of [-1, 600001, 1.5, NaN]) expect(validateSettingsPatch({ notifyDelayMs: n }).ok).toBe(false);
    expect(validateSettingsPatch({ notifyDelayMs: 0 }).ok).toBe(true); expect(validateSettingsPatch({ notifyDelayMs: 600000 }).ok).toBe(true);
    for (const n of [49, 10001, 1.5]) expect(validateSettingsPatch({ readLines: n }).ok).toBe(false);
    expect(validateSettingsPatch({ readLines: 50 }).ok).toBe(true); expect(validateSettingsPatch({ readLines: 10000 }).ok).toBe(true);
    expect(validateSettingsPatch({ submitKeys: ["ctrl+c"] }).ok).toBe(true); expect(validateSettingsPatch({ submitKeys: ["PageUp"] }).ok).toBe(false);
    expect(validateSettingsPatch({ submitKeys: [] }).ok).toBe(false); expect(validateSettingsPatch({ submitKeys: Array(9).fill("a") }).ok).toBe(false);
    expect(validateSettingsPatch({ nope: 1 }).ok).toBe(false);
  });
  test("GET and POST return settings", async () => {
    const d = await temp(); const s = new RuntimeSettingsStore(cfg(d));
    const get = await settingsRoute(new Request("http://x/api/settings"), cfg(d), s); expect(get.status).toBe(200); expect(await get.json()).toEqual(s.current());
    const post = await settingsRoute(new Request("http://x/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ readLines: 500 }) }), cfg(d), s);
    expect(post.status).toBe(200); expect(s.current().readLines).toBe(500);
    const before = s.current();
    const invalid = await settingsRoute(new Request("http://x/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ readLines: 49 }) }), cfg(d), s);
    expect(invalid.status).toBe(400); expect(s.current()).toEqual(before);
    expect((await settingsRoute(new Request("http://x/api/settings", { method: "PUT" }), cfg(d), s)).status).toBe(405);
  });
});
