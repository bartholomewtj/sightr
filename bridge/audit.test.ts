import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUDIT_FILE_MODE,
  AuditLog,
  createAuditLog,
  fileAuditAppender,
  formatAuditLine,
  fsAuditFileIo,
  type AppendFn,
  type AuditEntry,
  type AuditFileIo,
} from "./audit.ts";

import { createPaneQueue } from "./pane-queue.ts";
import { replyPane, keysPane, closePane, renamePane, type ReplySender } from "./pane-write-routes.ts";
import { renameTab, renameWorkspace, closeTab, createTab } from "./tree-routes.ts";
import { settingsRoute, RuntimeSettingsStore } from "./runtime-settings.ts";
import { lockClearAllRoute } from "./lock-routes.ts";
import { createLockStore } from "./lock.ts";
import { createWorkdir, type WorkdirHelpers } from "./workdir.ts";
import type { Config } from "./config.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { StateEngine } from "./state-engine.ts";

function testCfg(overrides: Partial<Config> = {}): Config {
  return {
    socketPath: "/tmp/herdr.sock",
    port: 8787,
    host: "127.0.0.1",
    allowNonLoopbackBind: false,
    pollMs: 1500,
    pollIdleMs: 12_000,
    notifyDelayMs: 30_000,
    readLines: 200,
    transcript: true,
    journalRoots: { claude: [], pi: [], grok: [] },
    submitKeys: ["Enter"],
    commandsFile: "/nope/commands.toml",
    keysFile: "/nope/keys.toml",
    trustedUser: "",
    trustedUserOptional: false,
    deviceHeader: "",
    deviceAllowlist: [],
    allowedOrigins: [],
    publicHosts: [],
    pushAllowedHosts: [],
    tailscaleHosts: [],
    allowAnyHost: true,
    vapidPublic: "",
    vapidPrivate: "",
    vapidSubject: "mailto:admin@example.com",
    stateDir: "/tmp/state",
    skipServe: false,
    workRoot: "",
    audit: true,
    auditContent: "preview", beacons: false,
    ...overrides,
  };
}

describe("formatAuditLine", () => {
  test("stamps an ISO ts and keeps a stable field order (ts, action, paneId, device, detail)", () => {
    const line = formatAuditLine(
      { action: "reply", paneId: "w1:p1", device: "phone", detail: { submit: true } },
      0,
    );
    expect(line).toBe(
      '{"ts":"1970-01-01T00:00:00.000Z","action":"reply","paneId":"w1:p1","device":"phone","detail":{"submit":true}}',
    );
  });

  test("omits paneId and device when absent/null (rather than emitting null)", () => {
    const line = formatAuditLine({ action: "workspace.create", device: null, detail: {} }, 0);
    expect(JSON.parse(line)).toEqual({
      ts: "1970-01-01T00:00:00.000Z",
      action: "workspace.create",
      detail: {},
    });
    expect(line).not.toContain("device");
    expect(line).not.toContain("paneId");
  });

  test("truncates a long string value to 120 chars + ellipsis", () => {
    const long = "x".repeat(500);
    const parsed = JSON.parse(formatAuditLine({ action: "reply", detail: { text: long } }, 0));
    expect(parsed.detail.text).toBe(`${"x".repeat(120)}…`);
  });

  test("folds embedded newlines so the output is a single line", () => {
    const line = formatAuditLine(
      { action: "reply", detail: { text: "line one\nline two\r\nthree" } },
      0,
    );
    expect(line).not.toContain("\n");
    expect(JSON.parse(line).detail.text).toBe("line one line two three");
  });

  test("sanitizes strings nested in arrays (e.g. key names)", () => {
    const parsed = JSON.parse(
      formatAuditLine({ action: "keys", detail: { keys: ["Enter", "a\nb"] } }, 0),
    );
    expect(parsed.detail.keys).toEqual(["Enter", "a b"]);
  });
});

describe("audit content redaction", () => {
  const entry = {
    action: "reply",
    paneId: "w1:p1",
    detail: {
      text: "deploy the thing and here is a secret nobody should keep on disk",
      submit: true,
      promptBinding: { checked: true, passed: true, expected: "user@host ~/work %" },
    },
  };

  test("preview is unchanged — the default must not move", () => {
    const line = JSON.parse(formatAuditLine(entry, 0));
    expect(line.detail.text).toContain("deploy the thing");
    expect(line.detail.promptBinding.expected).toContain("user@host");
  });

  test("none keeps the envelope and every non-string parameter", () => {
    const line = JSON.parse(formatAuditLine(entry, 0, "none"));
    expect(line.action).toBe("reply");
    expect(line.paneId).toBe("w1:p1");
    expect(line.detail.submit).toBe(true);
    expect(line.detail.promptBinding.checked).toBe(true);
    expect(line.detail.promptBinding.passed).toBe(true);
  });

  test("⛔ nothing of the message survives, at any nesting depth", () => {
    const raw = formatAuditLine(entry, 0, "none");
    expect(raw).not.toContain("deploy");
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("user@host");
    expect(raw).toContain("⟨redacted⟩");
  });

  test("⛔ the redaction is a constant — an exact length is itself content", () => {
    const line = JSON.parse(formatAuditLine(entry, 0, "none"));
    expect(line.detail.text).toBe("⟨redacted⟩");
    expect(line.detail.promptBinding.expected).toBe("⟨redacted⟩");
    expect(String(line.detail.text)).not.toMatch(/\d/);
  });

  test("an allowlisted key survives, including through the array it names", () => {
    const line = JSON.parse(
      formatAuditLine(
        { action: "keys", detail: { keys: ["ctrl+c", "Enter"], sent: false } },
        0,
        "none",
      ),
    );
    expect(line.detail.keys).toEqual(["ctrl+c", "Enter"]);
    expect(line.detail.sent).toBe(false);
  });

  test("⛔ an upload's client-declared filename redacts; the saved name identifies the entry", () => {
    const line = JSON.parse(
      formatAuditLine(
        {
          action: "upload",
          detail: { filename: "my-passport-scan.png", size: 4096, saved: "w1_p1-abc-1234.png" },
        },
        0,
        "none",
      ),
    );
    expect(line.detail.filename).toBe("⟨redacted⟩");
    expect(line.detail.size).toBe(4096);
    expect(line.detail.saved).toBe("w1_p1-abc-1234.png");
  });

  test("⛔ a string under an unlisted key redacts — the allowlist fails closed", () => {
    const line = JSON.parse(
      formatAuditLine(
        { action: "reply", detail: { somethingAddedLater: "a body nobody classified" } },
        0,
        "none",
      ),
    );
    expect(line.detail.somethingAddedLater).toBe("⟨redacted⟩");
  });

  test("⛔ a toJSON smuggle cannot re-inject content at stringify time", () => {
    const smuggle = {
      action: "reply",
      detail: { text: "x", evil: { toJSON: () => "smuggled-secret", keys: ["ctrl+c"] } },
    };
    const raw = formatAuditLine(smuggle, 0, "none");
    expect(raw).not.toContain("smuggled-secret");
    expect(JSON.parse(raw).detail.evil.keys).toEqual(["ctrl+c"]);
  });

  test("a function-valued property doesn't break preview mode either", () => {
    const raw = formatAuditLine(
      { action: "reply", detail: { text: "hello", cb: () => "nope" } },
      0,
    );
    expect(raw).not.toContain("nope");
    const line = JSON.parse(raw);
    expect(line.detail.text).toBe("hello");
    expect(line.detail.cb).toBeUndefined();
  });
});

describe("AuditLog", () => {
  test("records a formatted, newline-terminated line to the injected append", async () => {
    const lines: string[] = [];
    const append: AppendFn = (l) => void lines.push(l);
    const log = new AuditLog(append, { now: () => 0 });

    log.record({ action: "keys", paneId: "p1", detail: { keys: ["Enter"] } });
    await Promise.resolve();

    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: "1970-01-01T00:00:00.000Z",
      action: "keys",
      paneId: "p1",
      detail: { keys: ["Enter"] },
    });
  });

  test("a rejecting append never throws out of record() (audit must not break the action)", async () => {
    const append: AppendFn = () => Promise.reject(new Error("disk full"));
    const log = new AuditLog(append, { now: () => 0 });
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      expect(() => log.record({ action: "reply", detail: {} } satisfies AuditEntry)).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.warn = origWarn;
    }
    expect(warnings.filter((w) => w.includes("[audit]") && w.includes("write failed"))).toHaveLength(1);
  });

  test("a synchronously-throwing append is also swallowed", () => {
    const append: AppendFn = () => {
      throw new Error("boom");
    };
    const log = new AuditLog(append, { now: () => 0 });
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      expect(() => log.record({ action: "upload", detail: {} })).not.toThrow();
    } finally {
      console.warn = origWarn;
    }
  });

  test("record() does not delay its caller", () => {
    let unblocked = false;
    const neverEnding = new Promise<void>(() => {});
    const log = new AuditLog(() => neverEnding);
    log.record({ action: "reply", detail: {} });
    unblocked = true;
    expect(unblocked).toBe(true);
  });

  test("scoped({ device }) stamps every entry, leaves unscoped log untouched", async () => {
    const lines: string[] = [];
    const log = new AuditLog((l) => void lines.push(l), { now: () => 0 });
    const scopedLog = log.scoped({ device: "phone-7" });
    scopedLog.record({ action: "keys", paneId: "w1:p1", detail: { keys: ["Enter"] } });
    log.record({ action: "keys", paneId: "w1:p1", detail: {} });
    await Bun.sleep(5);
    expect(JSON.parse(lines[0]!)).toMatchObject({ action: "keys", device: "phone-7" });
    expect(lines[1]).not.toContain("phone-7");
  });

  test("an entry's own field beats the scope's", () => {
    const lines: string[] = [];
    const log = new AuditLog((l) => void lines.push(l), { now: () => 0 }).scoped({ device: "default-device" });
    log.record({ action: "reply", device: "override-device", detail: {} });
    expect(JSON.parse(lines[0]!).device).toBe("override-device");
  });

  test("a scoped view keeps the content mode as well as the attribution", () => {
    const lines: string[] = [];
    const log = new AuditLog((l) => void lines.push(l), {
      now: () => 0,
      content: "none",
    }).scoped({ device: "phone-7" });
    log.record({ action: "reply", paneId: "w1:p1", detail: { text: "the secret" } });
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ action: "reply", device: "phone-7" });
    expect(lines[0]).not.toContain("the secret");
  });
});

function fakeIo(seed: Record<string, string> = {}): AuditFileIo & {
  files: Record<string, string>;
  failRotate?: boolean;
} {
  const files = { ...seed };
  const io = {
    files,
    failRotate: false,
    size: async (p: string) => Buffer.byteLength(files[p] ?? "", "utf8"),
    rotate: async (from: string, to: string) => {
      if (io.failRotate) throw new Error("EACCES");
      if (files[from] === undefined) throw new Error("ENOENT");
      files[to] = files[from]!;
      delete files[from];
    },
    append: async (p: string, line: string) => {
      files[p] = (files[p] ?? "") + line;
    },
  };
  return io;
}

describe("fileAuditAppender rotation", () => {
  test("rotates at the cap: the old content lands in .1 and the line starts a fresh log", async () => {
    const io = fakeIo();
    const append = fileAuditAppender("/s/audit.log", io, 20);
    await append("a".repeat(20) + "\n");
    expect(io.files["/s/audit.log.1"]).toBeUndefined();
    await append("second\n");
    expect(io.files["/s/audit.log.1"]).toBe("a".repeat(20) + "\n");
    expect(io.files["/s/audit.log"]).toBe("second\n");
  });

  test("keeps exactly one generation — a second rotation replaces .1", async () => {
    const io = fakeIo();
    const append = fileAuditAppender("/s/audit.log", io, 8);
    await append("first-1\n");
    await append("second2\n");
    expect(io.files["/s/audit.log.1"]).toBe("first-1\n");
    await append("third\n");
    expect(io.files["/s/audit.log.1"]).toBe("second2\n");
    expect(io.files["/s/audit.log"]).toBe("third\n");
    expect(Object.keys(io.files).toSorted()).toEqual(["/s/audit.log", "/s/audit.log.1"]);
  });

  test("a failed rename still appends — an oversized trail beats a missing line", async () => {
    const io = fakeIo();
    io.failRotate = true;
    const append = fileAuditAppender("/s/audit.log", io, 8);
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      await append("first-1\n");
      await append("second\n");
    } finally {
      console.warn = origWarn;
    }
    expect(io.files["/s/audit.log"]).toBe("first-1\nsecond\n");
    expect(io.files["/s/audit.log.1"]).toBeUndefined();
    expect(warnings.some((w) => w.includes("could not rotate"))).toBe(true);
  });

  test("lines below the cap never rotate", async () => {
    const io = fakeIo();
    const append = fileAuditAppender("/s/audit.log", io, 1024);
    for (let i = 0; i < 20; i++) await append(`line ${i}\n`);
    expect(io.files["/s/audit.log.1"]).toBeUndefined();
    expect(io.files["/s/audit.log"]!.split("\n")).toHaveLength(21);
  });

  test("a flood of calls stays bounded — the whole trail never exceeds two generations", async () => {
    const io = fakeIo();
    const cap = 200;
    const append = fileAuditAppender("/s/audit.log", io, cap);
    const line = `${JSON.stringify({ action: "reply", detail: { code: "unauthorized" } })}\n`;
    for (let i = 0; i < 1000; i++) await append(line);
    expect(Object.keys(io.files).toSorted()).toEqual(["/s/audit.log", "/s/audit.log.1"]);
    const total = Object.values(io.files).reduce((n, c) => n + Buffer.byteLength(c, "utf8"), 0);
    expect(total).toBeLessThanOrEqual(2 * (cap + Buffer.byteLength(line, "utf8")));
    expect(1000 * Buffer.byteLength(line, "utf8")).toBeGreaterThan(total * 10);
  });

  test("seeds its counter from the existing file, so a restart doesn't reset the cap", async () => {
    const io = fakeIo({ "/s/audit.log": "x".repeat(64) + "\n" });
    const append = fileAuditAppender("/s/audit.log", io, 32);
    await append("after restart\n");
    expect(io.files["/s/audit.log.1"]).toBe("x".repeat(64) + "\n");
    expect(io.files["/s/audit.log"]).toBe("after restart\n");
  });
});

describe("real filesystem audit operations", () => {
  test("fsAuditFileIo().append creates the file with the line in it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-audit-test-"));
    try {
      const io = fsAuditFileIo();
      const filePath = join(dir, "audit.log");
      await io.append(filePath, "test line\n");
      const content = await readFile(filePath, "utf8");
      expect(content).toBe("test line\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("AUDIT_FILE_MODE is 0o600", () => {
    expect(AUDIT_FILE_MODE).toBe(0o600);
  });

  test.skipIf(process.platform === "win32")("file mode on disk is 0o600 on non-windows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-audit-test-"));
    try {
      const io = fsAuditFileIo();
      const filePath = join(dir, "audit.log");
      await io.append(filePath, "test line\n");
      const st = await stat(filePath);
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("createAuditLog with enabled: false writes nothing and creates no file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-audit-test-"));
    try {
      const log = createAuditLog({ stateDir: dir, enabled: false, content: "preview" });
      log.record({ action: "reply", detail: { text: "secret" } });
      log.record({ action: "keys", detail: { keys: ["Enter"] } });
      await Bun.sleep(10);
      const files = await readdir(dir);
      expect(files).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("createAuditLog with enabled: true and content: none writes redacted JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-audit-test-"));
    try {
      const log = createAuditLog({ stateDir: dir, enabled: true, content: "none" });
      log.record({ action: "reply", paneId: "w1:p1", detail: { text: "top-secret-password", submit: true } });
      await Bun.sleep(50);
      const filePath = join(dir, "audit.log");
      const content = await readFile(filePath, "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.action).toBe("reply");
      expect(parsed.paneId).toBe("w1:p1");
      expect(parsed.detail.submit).toBe(true);
      expect(parsed.detail.text).toBe("⟨redacted⟩");
      expect(content).not.toContain("top-secret-password");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("route audit coverage", () => {
  class FakeClient implements ReplySender {
    async sendPaneText(_p: string, _t: string): Promise<void> {}
    async sendPaneKeys(_p: string, _k: string[]): Promise<void> {}
    async closePane(_p: string): Promise<void> {}
    async renamePane(_p: string, _l: string | null): Promise<void> {}
    async renameTab(_t: string, _l: string): Promise<void> {}
    async renameWorkspace(_w: string, _l: string): Promise<void> {}
    async closeTab(_t: string): Promise<void> {}
    async createTab(ws: string, opts: { label?: string; cwd?: string }): Promise<{ paneId: string; workspaceId: string; tabId: string; cwd: string }> {
      return { paneId: "w1:p2", workspaceId: ws, tabId: "t1", cwd: opts.cwd ?? "/work" };
    }
    async createWorkspace(opts: { cwd: string; label?: string }): Promise<{ paneId: string; workspaceId: string; tabId: string; cwd: string; workspaceLabel?: string }> {
      return { paneId: "w2:p1", workspaceId: "w2", tabId: "t2", cwd: opts.cwd, workspaceLabel: opts.label };
    }
  }

  function jsonReq(url: string, body: unknown): Request {
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("records exactly one line per write action with correct action and paneId", async () => {
    const lines: string[] = [];
    const log = new AuditLog((l) => void lines.push(l), { now: () => 0 });
    const client = new FakeClient();
    const queue = createPaneQueue();
    const cfg = testCfg();

    // 1. replyPane
    await replyPane(client as unknown as HerdrClient, cfg, "w1:p1", jsonReq("http://x/api/pane/w1:p1/reply", { text: "hello", submit: false }), queue, log);
    await Bun.sleep(5);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ action: "reply", paneId: "w1:p1" });

    // 2. keysPane
    await keysPane(client as unknown as HerdrClient, cfg, "w1:p1", jsonReq("http://x/api/pane/w1:p1/keys", { keys: ["Enter"] }), queue, log);
    await Bun.sleep(5);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ action: "keys", paneId: "w1:p1" });

    // 3. closePane
    await closePane(client as unknown as HerdrClient, "w1:p1", jsonReq("http://x/api/pane/w1:p1/close", {}), queue, log);
    await Bun.sleep(5);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!)).toMatchObject({ action: "pane.close", paneId: "w1:p1" });

    // 4. renamePane
    await renamePane(client as unknown as HerdrClient, "w1:p1", jsonReq("http://x/api/pane/w1:p1/rename", { label: "my-pane" }), queue, log);
    await Bun.sleep(5);
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[3]!)).toMatchObject({ action: "pane.rename", paneId: "w1:p1" });

    // 5. renameTab
    await renameTab(client as unknown as HerdrClient, "t1", jsonReq("http://x/api/tab/t1/rename", { label: "my-tab" }), log);
    await Bun.sleep(5);
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[4]!)).toMatchObject({ action: "tab.rename" });

    // 6. closeTab
    await closeTab(client as unknown as HerdrClient, "t1", jsonReq("http://x/api/tab/t1/close", {}), log);
    await Bun.sleep(5);
    expect(lines).toHaveLength(6);
    expect(JSON.parse(lines[5]!)).toMatchObject({ action: "tab.close" });

    // 7. createTab
    const engine = { current: () => ({ workspaces: [{ workspaceId: "w1", label: "Work" }] }) };
    await createTab(client as unknown as HerdrClient, engine as unknown as StateEngine, jsonReq("http://x/api/tab", { workspaceId: "w1", label: "Tab2" }), log);
    await Bun.sleep(5);
    expect(lines).toHaveLength(7);
    expect(JSON.parse(lines[6]!)).toMatchObject({ action: "tab.create", paneId: "w1:p2" });

    // 8. renameWorkspace
    await renameWorkspace(client as unknown as HerdrClient, "w1", jsonReq("http://x/api/workspace/w1/rename", { label: "Space1" }), log);
    await Bun.sleep(5);
    expect(lines).toHaveLength(8);
    expect(JSON.parse(lines[7]!)).toMatchObject({ action: "workspace.rename" });

    // 9. settingsRoute
    const settingsStore = new RuntimeSettingsStore(cfg);
    await settingsRoute(jsonReq("http://x/api/settings", { readLines: 100 }), cfg, settingsStore, log);
    await Bun.sleep(5);
    expect(lines).toHaveLength(9);
    expect(JSON.parse(lines[8]!)).toMatchObject({ action: "settings" });

    // 10. lockClearAllRoute
    const lock = createLockStore(cfg.stateDir);
    await lockClearAllRoute(new Request("http://localhost/api/lock/clear-all", { method: "POST", headers: { origin: "http://localhost", host: "localhost" } }), new URL("http://localhost/api/lock/clear-all"), cfg, lock, log);
    await Bun.sleep(5);
    expect(lines).toHaveLength(10);
    expect(JSON.parse(lines[9]!)).toMatchObject({ action: "lock.clear-all" });
  });

  test("createWorkdir records files.save and files.delete, but zero lines from GET", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-workdir-audit-"));
    try {
      const filePath = join(dir, "note.txt");
      await writeFile(filePath, "hello world");
      const lines: string[] = [];
      const log = new AuditLog((l) => void lines.push(l), { now: () => 0 });
      const cfg = testCfg({ workRoot: dir });
      const helpers: WorkdirHelpers = {
        guard: () => null,
        json: (v, _e, status = 200) => new Response(JSON.stringify(v), { status }),
        text: (v, status) => new Response(v, { status }),
        failureText: () => "failed",
        secure: (r) => r,
        contentTypes: {},
        paneCwd: () => null,
        requireJsonBody: (req) => req.headers.get("content-type")?.startsWith("application/json") ? null : new Response(null, { status: 415 }),
        auditFor: () => log,
      };
      const workdir = createWorkdir(cfg, helpers);

      // GET read should produce zero lines
      const getRes = await workdir.handle(new Request("http://x/api/files?path=note.txt"), new URL("http://x/api/files?path=note.txt"));
      expect(getRes.status).toBe(200);
      await Bun.sleep(5);
      expect(lines).toHaveLength(0);

      // Save file
      const st = await stat(filePath);
      const saveReq = jsonReq("http://x/api/files/save", { path: "note.txt", text: "updated text", mtimeMs: st.mtimeMs });
      const saveRes = await workdir.handle(saveReq, new URL("http://x/api/files/save"));
      expect(saveRes.status).toBe(200);
      await Bun.sleep(5);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ action: "files.save", detail: { name: "note.txt", size: 12 } });

      // Delete file
      const delReq = jsonReq("http://x/api/files/delete", { path: "note.txt" });
      const delRes = await workdir.handle(delReq, new URL("http://x/api/files/delete"));
      expect(delRes.status).toBe(200);
      await Bun.sleep(5);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]!)).toMatchObject({ action: "files.delete", detail: { name: "note.txt" } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("zero lines from a refused write (PaneBusyError)", async () => {
    const lines: string[] = [];
    const log = new AuditLog((l) => void lines.push(l), { now: () => 0 });
    const busyQueue = {
      run: async () => {
        const { PaneBusyError } = await import("./pane-queue.ts");
        throw new PaneBusyError("busy");
      },
    };
    const client = new FakeClient();
    const cfg = testCfg();
    const res = await replyPane(client as unknown as HerdrClient, cfg, "w1:p1", jsonReq("http://x/api/pane/w1:p1/reply", { text: "hi" }), busyQueue as any, log);
    expect(res.status).toBe(503);
    await Bun.sleep(10);
    expect(lines).toHaveLength(0);
  });

  test("a route whose append throws still returns its normal response", async () => {
    const failingLog = new AuditLog(() => {
      throw new Error("append failed");
    });
    const client = new FakeClient();
    const queue = createPaneQueue();
    const cfg = testCfg();
    const res = await replyPane(client as unknown as HerdrClient, cfg, "w1:p1", jsonReq("http://x/api/pane/w1:p1/reply", { text: "hi", submit: false }), queue, failingLog);
    expect(res.status).toBe(200);
  });
});
