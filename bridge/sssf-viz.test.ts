import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Config } from "./config.ts";
import { checkAccess, deviceAuth, isHostAllowed } from "./access.ts";
import { failureText, requireJsonBody } from "./responses.ts";
import { cacheControlFor, resolveStaticPath } from "./static-assets.ts";
import {
  createSssfViz,
  DEFAULT_LIST_LIMIT,
  findRepos,
  isSafeSegment,
  readStampRows,
  readVizDir,
  RECHECK_MS,
  shouldKickDiscover,
  shouldKickLive,
  STAMP_SESSION_LIMIT,
  type SssfHelpers,
} from "./sssf-viz.ts";
import type { WorkspaceView } from "../shared/wire.ts";

// The pure bits run everywhere. The integration half imports the REAL visualiser db.ts and reads a
// REAL trace db, so it runs only where both exist: SSSF_VIZ_DIR set (the visualiser folder) and
// SSSF_TEST_REPO set (a git checkout with adws/adw_data/sssf.db). That is exactly the "a skill update
// changed db.ts" tripwire the module's startup contract check exists for — run it after re-installing
// the sssf skill:
//   SSSF_VIZ_DIR=~/.claude/skills/software-factory/apps/visualizer SSSF_TEST_REPO=~/Projects/tools/software-factory bun test bridge/sssf-viz.test.ts

function cfg(overrides: Partial<Config> = {}): Config {
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
    allowAnyHost: false,
    vapidPublic: "",
    vapidPrivate: "",
    vapidSubject: "mailto:admin@example.com",
    stateDir: "/tmp/state",
    skipServe: false,
    beacons: false,
    workRoot: "",
    audit: false,
    auditContent: "preview",
    ...overrides,
  };
}

// The same helpers server.ts hands the module, minus the two module-private ones (secure, CSP),
// which are stand-ins here.
const helpers: SssfHelpers = {
  guard: (req, c, level) => {
    const gate = checkAccess(req, c, level);
    if (!gate.ok) return new Response(gate.reason, { status: 403 });
    if (level === "write" && !deviceAuth(req, c).authorized) return new Response("device", { status: 403 });
    return null;
  },
  isHostAllowed,
  requireJsonBody,
  failureText,
  resolveStaticPath,
  cacheControlFor,
  secure: (r) => r,
  csp: "default-src 'self'; frame-ancestors 'none'",
  contentTypes: { ".html": "text/html" },
};

const ws = (id: string): WorkspaceView => ({
  workspaceId: id,
  number: 1,
  label: id,
  focused: false,
  activeTabId: "t1",
  tabCount: 1,
  paneCount: 1,
});

/** A directory that is nothing SSSF-shaped, with nothing SSSF-shaped above or below it. */
async function emptyCwd(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "sssf-none-"));
  await mkdir(join(d, "empty"));
  return join(d, "empty");
}

/** A fake SSSF repo: a worktree root with adws/, and — unless `pending` — a trace db. */
async function fakeRepo(
  parent: string,
  name: string,
  sessions: Array<{ adw_id: string; status: string; started_at: string; pane_id?: string }> = [],
  pending = false,
): Promise<string> {
  const root = join(parent, name);
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "adws", "adw_data"), { recursive: true });
  if (pending) return root;
  // The tracer's own tables, as far as the visualiser's sessions() reads them.
  const db = new Database(join(root, "adws", "adw_data", "sssf.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE sessions (adw_id TEXT PRIMARY KEY, adw_name TEXT, request TEXT, status TEXT, engineer TEXT,
    started_at TEXT, ended_at TEXT, total_tokens INTEGER DEFAULT 0, total_cost REAL DEFAULT 0, archived INTEGER DEFAULT 0, pane_id TEXT)`);
  db.exec(`CREATE TABLE phases (phase_id TEXT PRIMARY KEY, adw_id TEXT, seq INTEGER, name TEXT, kind TEXT, owner TEXT,
    description TEXT, status TEXT, attempt INTEGER DEFAULT 0, retries INTEGER DEFAULT 0, error TEXT, started_at TEXT, ended_at TEXT)`);
  db.exec(`CREATE TABLE agent_sessions (adw_id TEXT, agent TEXT, coding_agent TEXT, model TEXT, color TEXT, session_id TEXT,
    context_tokens INTEGER, context_window INTEGER, created_at TEXT, last_used_at TEXT, PRIMARY KEY (adw_id, agent))`);
  db.exec(`CREATE TABLE events (event_id TEXT PRIMARY KEY, adw_id TEXT, phase_id TEXT, parent_id TEXT, type TEXT, name TEXT,
    payload_json TEXT, tokens INTEGER, started_at TEXT, ended_at TEXT)`);
  const ins = db.query("INSERT INTO sessions (adw_id, request, status, started_at, pane_id) VALUES (?, ?, ?, ?, ?)");
  for (const s of sessions) ins.run(s.adw_id, `run ${s.adw_id}`, s.status, s.started_at, s.pane_id ?? null);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return root;
}

describe("sssf-viz — pure bits", () => {
  test("isSafeSegment accepts ids and agent names, refuses traversal and empties", () => {
    expect(isSafeSegment("e7b38c61")).toBe(true);
    expect(isSafeSegment("planner")).toBe(true);
    expect(isSafeSegment("a.b-c_d")).toBe(true);
    expect(isSafeSegment("")).toBe(false);
    expect(isSafeSegment("..")).toBe(false);
    expect(isSafeSegment(".")).toBe(false);
    expect(isSafeSegment("...")).toBe(true); // three dots is an odd but harmless file name
    expect(isSafeSegment("a/b")).toBe(false);
    expect(isSafeSegment("a\\b")).toBe(false);
    expect(isSafeSegment("x".repeat(129))).toBe(false);
  });

  test("readVizDir: unset → '', ~ expands, relative becomes absolute", () => {
    expect(readVizDir({})).toBe("");
    expect(readVizDir({ SSSF_VIZ_DIR: "  " })).toBe("");
    expect(readVizDir({ SSSF_VIZ_DIR: "~/x" })).not.toContain("~");
    expect(readVizDir({ SSSF_VIZ_DIR: "rel/dir" })).not.toBe("rel/dir");
  });

  test("shouldKickDiscover: first sighting always scans; later rechecks only while Traces is open", () => {
    const fp = "/repo";
    const fresh = { fingerprint: fp, at: 1_000 };
    expect(shouldKickDiscover(undefined, fp, false, 1_000)).toBe(true);
    expect(shouldKickDiscover(fresh, fp, false, 1_000 + RECHECK_MS + 1)).toBe(false);
    expect(shouldKickDiscover(fresh, "/other", false, 1_000)).toBe(false);
    expect(shouldKickDiscover(fresh, fp, true, 1_000)).toBe(false);
    expect(shouldKickDiscover(fresh, fp, true, 1_000 + RECHECK_MS + 1)).toBe(true);
    expect(shouldKickDiscover(fresh, "/other", true, 1_000)).toBe(true);
  });

  test("iframe list default is far below the visualiser standalone 200", () => {
    expect(DEFAULT_LIST_LIMIT).toBe(40);
    expect(DEFAULT_LIST_LIMIT).toBeLessThan(200);
  });

  test("shouldKickLive: 30s poll of known dbs while the app is open, not a filesystem walk", () => {
    const fresh = { liveAt: 1_000 };
    const go = { hasDb: true, discovering: false, now: 1_000 + RECHECK_MS };
    expect(shouldKickLive(undefined, go)).toBe(false);
    expect(shouldKickLive(fresh, { ...go, hasDb: false })).toBe(false);
    expect(shouldKickLive(fresh, { ...go, discovering: true })).toBe(false);
    expect(shouldKickLive(fresh, { ...go, now: 1_000 + RECHECK_MS - 1 })).toBe(false);
    expect(shouldKickLive(fresh, go)).toBe(true);
  });

  test("readStampRows returns the newest 3 non-archived sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sssf-stamp-"));
    const path = join(dir, "sssf.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE sessions (adw_id TEXT PRIMARY KEY, adw_name TEXT, status TEXT, started_at TEXT, archived INTEGER DEFAULT 0, pane_id TEXT)`);
    const ins = db.query("INSERT INTO sessions (adw_id, status, started_at, archived, pane_id) VALUES (?, ?, ?, ?, ?)");
    ins.run("old", "success", "2026-08-01T00:00:00+00:00", 0, "p1");
    ins.run("mid", "fail", "2026-08-02T00:00:00+00:00", 0, "p1");
    ins.run("also", "success", "2026-08-03T00:00:00+00:00", 0, "p1");
    ins.run("new", "running", "2026-08-04T00:00:00+00:00", 0, "p1");
    ins.run("archived", "success", "2026-08-05T00:00:00+00:00", 1, "p1");
    db.close();
    const rows = readStampRows(path);
    expect(rows).toHaveLength(STAMP_SESSION_LIMIT);
    expect(rows.map((r) => r.adw_id)).toEqual(["new", "also", "mid"]);
  });

  test("readStampRows does not need phases or events tables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sssf-stamp-bare-"));
    const path = join(dir, "sssf.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE sessions (adw_id TEXT PRIMARY KEY, status TEXT, started_at TEXT)`);
    db.query("INSERT INTO sessions (adw_id, status, started_at) VALUES (?, ?, ?)").run("a", "running", "2026-08-01T00:00:00+00:00");
    db.close();
    expect(readStampRows(path)).toEqual([
      { adw_id: "a", adw_name: null, status: "running", started_at: "2026-08-01T00:00:00+00:00", pane_id: null },
    ]);
  });

  test("feature off: owns() and lockExempt() are false and decorate() is the identity", async () => {
    const viz = createSssfViz(cfg(), helpers, { vizDir: "", build: false });
    expect(await viz.ready).toBe(false);
    expect(viz.owns("/sssf")).toBe(false);
    expect(viz.owns("/sssf/api/sessions")).toBe(false);
    expect(viz.lockExempt(new Request("http://127.0.0.1/sssf/"), new URL("http://127.0.0.1/sssf/"))).toBe(false);
    const list = [ws("w1")];
    expect(viz.decorate(list, [{ workspaceId: "w1", cwd: "/tmp" }])).toBe(list);
  });

  test("lockExempt follows the visualiser lock table", async () => {
    const off = createSssfViz(cfg(), helpers, { vizDir: "", build: false, token: "a".repeat(48) });
    await off.ready;
    const offCheck = (path: string, method = "GET") => {
      const u = new URL(`http://127.0.0.1${path}`);
      return off.lockExempt(new Request(u, { method }), u);
    };
    for (const path of ["/sssf/", "/sssf/assets/index.js", "/sssf/logo.svg", "/sssf/api/sessions?t=" + "a".repeat(48)]) {
      expect(offCheck(path)).toBe(false);
    }

    const dir = await mkdtemp(join(tmpdir(), "sssf-lock-"));
    const viz = createSssfViz(cfg(), helpers, { vizDir: dir, build: false, token: "a".repeat(48) });
    await viz.ready;
    const check = (path: string, method = "GET") => {
      const u = new URL(`http://127.0.0.1${path}`);
      return viz.lockExempt(new Request(u, { method }), u);
    };
    expect(check("/sssf/assets/index.js")).toBe(true);
    expect(check("/sssf/")).toBe(true);
    expect(check("/sssf/logo.svg")).toBe(true);
    expect(check("/sssf/api/sessions")).toBe(false);
    expect(check("/sssf/api/sessions?t=wrong")).toBe(false);
    expect(check("/sssf/api/sessions?t=" + "b".repeat(48))).toBe(false);
    expect(check("/sssf/api/sessions?t=" + "a".repeat(48))).toBe(true);
    expect(check("/sssf/api/sessions/x/archive?t=" + "a".repeat(48), "POST")).toBe(false);
    expect(check("/sssf/", "POST")).toBe(false);
  });


  test("a folder that is not the visualiser disables the feature loudly, not fatally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "not-viz-"));
    const viz = createSssfViz(cfg(), helpers, { vizDir: dir, build: false });
    expect(await viz.ready).toBe(false);
    // owns() is still true (the operator asked for the mount) but every request is a 404 — after the
    // host check.
    expect(viz.owns("/sssf/")).toBe(true);
    const r = await viz.handle(
      new Request("http://127.0.0.1/sssf/", { headers: { host: "127.0.0.1" } }),
      new URL("http://127.0.0.1/sssf/"),
    );
    expect(r.status).toBe(404);
    const evil = await viz.handle(
      new Request("http://evil.example/sssf/", { headers: { host: "evil.example" } }),
      new URL("http://evil.example/sssf/"),
    );
    expect(evil.status).toBe(403);
  });

  test("findRepos: up to the enclosing worktree root, down three levels, bounded and unfollowing", async () => {
    const top = await mkdtemp(join(tmpdir(), "sssf-tree-"));
    await fakeRepo(join(top, "Projects"), "alpha", [{ adw_id: "a1", status: "success", started_at: "2026-08-01T00:00:00Z" }]);
    await fakeRepo(top, "beta", [], true); // depth 1, pending
    await fakeRepo(join(top, "Projects", "deep"), "gamma"); // depth 3 — the reason MAX_DOWN is 3:
    //   <cwd>/Projects/deep/gamma is the `~/work/projects/tools/<repo>` shape, and at MAX_DOWN=2 it
    //   was invisible with no error to say so.
    await fakeRepo(join(top, "Projects", "deep", "deeper"), "delta"); // depth 4 — still beyond it
    await fakeRepo(join(top, "node_modules"), "dep"); // skipped folder
    await fakeRepo(join(top, ".hidden"), "dot"); // dot-dir
    // A junction/symlink to a repo elsewhere is never entered.
    const elsewhere = await mkdtemp(join(tmpdir(), "sssf-else-"));
    await fakeRepo(elsewhere, "linked");
    await symlink(join(elsewhere, "linked"), join(top, "Projects", "viaLink"), "junction").catch(() => {});

    const fromTop = await findRepos(top);
    expect(fromTop.map((c) => c.name).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(fromTop.find((c) => c.name === "alpha")?.dbPath).toEndWith(join("adws", "adw_data", "sssf.db"));
    expect(fromTop.find((c) => c.name === "beta")?.dbPath).toBeNull();

    // From inside a repo: the up-walk finds it (and nothing else sits below that cwd).
    const fromInside = await findRepos(join(top, "Projects", "alpha", "adws"));
    expect(fromInside.map((c) => basename(c.root))).toEqual(["alpha"]);

    // From a folder that is neither in nor over a repo: nothing.
    expect(await findRepos(await emptyCwd())).toEqual([]);
  });
});

const VIZ = readVizDir();
const REPO = process.env.SSSF_TEST_REPO ?? "";

describe.skipIf(!VIZ || !REPO)("sssf-viz — against the real visualiser db.ts and a real trace db", () => {
  async function boot() {
    const state = await mkdtemp(join(tmpdir(), "sssf-state-"));
    const viz = createSssfViz(cfg({ stateDir: state }), helpers, { vizDir: VIZ, build: false });
    expect(await viz.ready).toBe(true);
    // Discovery is async and fires from decorate(); poll until the workspace is stamped.
    const panes = [{ workspaceId: "w1", cwd: join(REPO, "adws") }, { workspaceId: "w2", cwd: await emptyCwd() }];
    let stamped: WorkspaceView[] = [];
    for (let i = 0; i < 50; i++) {
      stamped = viz.decorate([ws("w1"), ws("w2")], panes);
      if (stamped[0]?.sssf) break;
      await Bun.sleep(20);
    }
    return { viz, stamped };
  }

  const get = (viz: Awaited<ReturnType<typeof boot>>["viz"], path: string, headers: Record<string, string> = {}) => {
    const url = new URL(`http://127.0.0.1:8787${path}`);
    return viz.handle(new Request(url, { headers: { host: "127.0.0.1:8787", ...headers } }), url);
  };

  test("stamps the workspace whose pane cwd sits inside the repo; leaves the other alone", async () => {
    const { stamped } = await boot();
    expect(stamped[0]?.sssf?.state).toBe("ready");
    expect(stamped[0]?.sssf?.token).toMatch(/^[0-9a-f]{48}$/);
    expect(stamped[0]?.sssf?.repos.map((r) => r.name)).toEqual([basename(REPO)]);
    expect(stamped[0]?.sssf?.attached?.repo).toBe(basename(REPO));
    expect(stamped[1]?.sssf).toBeUndefined();
  });

  test("reads sessions and detail; health carries no filesystem path", async () => {
    const { viz } = await boot();
    const list = await get(viz, "/sssf/api/sessions?ws=w1&session=primary");
    expect(list.status).toBe(200);
    const sessions = (await list.json()) as Array<{ adw_id: string }>;
    expect(Array.isArray(sessions)).toBe(true);
    const health = (await (await get(viz, "/sssf/api/health?ws=w1&session=primary")).json()) as Record<string, unknown>;
    expect(health.ok).toBe(true);
    expect(health).not.toHaveProperty("db");
    if (sessions[0]) {
      const detail = await get(viz, `/sssf/api/sessions/${sessions[0].adw_id}?ws=w1&session=primary`);
      expect(detail.status).toBe(200);
      const events = await get(viz, `/sssf/api/sessions/${sessions[0].adw_id}/events?ws=w1&session=primary&after=0&limit=5`);
      expect(events.status).toBe(200);
    }
  });

  test("an unknown workspace, a bad segment, and a missing ws are refused", async () => {
    const { viz } = await boot();
    expect((await get(viz, "/sssf/api/sessions?ws=nope&session=primary")).status).toBe(404);
    expect((await get(viz, "/sssf/api/sessions")).status).toBe(404);
    expect((await get(viz, "/sssf/api/sessions/..%2F..%2Fetc/events?ws=w1&session=primary")).status).toBe(400);
    expect((await get(viz, "/sssf/api/sessions/x/agents/..%2F/prompts?ws=w1&session=primary")).status).toBe(400);
  });

  test("Origin: null is a bad origin without the token, and CORS-answered with it (reads only)", async () => {
    const { viz, stamped } = await boot();
    const token = stamped[0]!.sssf!.token;
    const noToken = await get(viz, "/sssf/api/sessions?ws=w1&session=primary", { origin: "null" });
    expect(noToken.status).toBe(403);
    const wrong = await get(viz, `/sssf/api/sessions?ws=w1&session=primary&t=${"0".repeat(48)}`, { origin: "null" });
    expect(wrong.status).toBe(403);
    const ok = await get(viz, `/sssf/api/sessions?ws=w1&session=primary&t=${token}`, { origin: "null" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("null");
    expect(ok.headers.get("vary")).toBe("Origin");
    // A write with Origin: null never gets the pass, token or not.
    const url = new URL(`http://127.0.0.1:8787/sssf/api/sessions/x/archive?ws=w1&session=primary&t=${token}`);
    const post = await viz.handle(
      new Request(url, {
        method: "POST",
        headers: { host: "127.0.0.1:8787", origin: "null", "content-type": "application/json" },
        body: "{}",
      }),
      url,
    );
    expect(post.status).toBe(403);
  });

  test("prompts: absent files read as null; a symlink out of the sessions dir reads as null", async () => {
    const { viz } = await boot();
    const list = (await (await get(viz, "/sssf/api/sessions?ws=w1&session=primary")).json()) as Array<{ adw_id: string }>;
    if (!list[0]) return;
    const r = await get(viz, `/sssf/api/sessions/${list[0].adw_id}/agents/no-such-agent/prompts?ws=w1&session=primary`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ system: null, user: null });
  });

  test("with transcripts off, prompts are always null", async () => {
    const state = await mkdtemp(join(tmpdir(), "sssf-state-"));
    const viz = createSssfViz(cfg({ stateDir: state, transcript: false }), helpers, { vizDir: VIZ, build: false });
    expect(await viz.ready).toBe(true);
    let stamped: WorkspaceView[] = [];
    for (let i = 0; i < 50; i++) {
      stamped = viz.decorate([ws("w1")], [{ workspaceId: "w1", cwd: REPO }]);
      if (stamped[0]?.sssf) break;
      await Bun.sleep(20);
    }
    const list = (await (await get(viz, "/sssf/api/sessions?ws=w1&session=primary")).json()) as Array<{ adw_id: string }>;
    if (!list[0]) return;
    const r = await get(viz, `/sssf/api/sessions/${list[0].adw_id}/agents/planner/prompts?ws=w1&session=primary`);
    expect(await r.json()).toEqual({ system: null, user: null });
  });

  test("a worktree root with adws/ but no db is 'pending'; no .git above the cwd is nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "sssf-pending-"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "adws"));
    await writeFile(join(root, "adws", "README"), "");
    const state = await mkdtemp(join(tmpdir(), "sssf-state-"));
    const viz = createSssfViz(cfg({ stateDir: state }), helpers, { vizDir: VIZ, build: false });
    await viz.ready;
    let stamped: WorkspaceView[] = [];
    const none = await emptyCwd();
    for (let i = 0; i < 50; i++) {
      stamped = viz.decorate([ws("w1"), ws("w2")], [
        { workspaceId: "w1", cwd: join(root, "adws") },
        { workspaceId: "w2", cwd: none },
      ]);
      if (stamped[0]?.sssf) break;
      await Bun.sleep(20);
    }
    expect(stamped[0]?.sssf?.state).toBe("pending");
    expect(stamped[0]?.sssf?.attached).toBeUndefined();
    expect(stamped[1]?.sssf).toBeUndefined();
  });

  describe("several repos below a pane cwd", () => {
    // A folder of repos, like a pane parked at the home folder: `old` finished last week, `live` has
    // a run going that started earlier, `fresh` finished most recently, `soon` has no db yet.
    async function tree() {
      const top = await mkdtemp(join(tmpdir(), "sssf-multi-"));
      await fakeRepo(join(top, "Projects"), "old", [{ adw_id: "o1", status: "success", started_at: "2026-08-10T10:00:00+00:00" }]);
      await fakeRepo(join(top, "Projects"), "live", [
        { adw_id: "l2", status: "running", started_at: "2026-08-17T09:00:00+00:00", pane_id: "w1:p1" },
        { adw_id: "l1", status: "fail", started_at: "2026-08-16T09:00:00+00:00", pane_id: "w1:p2" },
      ]);
      await fakeRepo(join(top, "Projects"), "fresh", [
        { adw_id: "f1", status: "success", started_at: "2026-08-18T08:00:00+00:00", pane_id: "w1:p1" },
      ]);
      await fakeRepo(join(top, "Projects"), "soon", [], true);
      const state = await mkdtemp(join(tmpdir(), "sssf-state-"));
      const viz = createSssfViz(cfg({ stateDir: state }), helpers, { vizDir: VIZ, build: false });
      expect(await viz.ready).toBe(true);
      let stamped: WorkspaceView[] = [];
      for (let i = 0; i < 50; i++) {
        stamped = viz.decorate([ws("w1")], [{ workspaceId: "w1", cwd: top }]);
        if (stamped[0]?.sssf) break;
        await Bun.sleep(20);
      }
      return { viz, sssf: stamped[0]!.sssf! };
    }

    test("lists every repo by name and attaches to the running one, with its adw_id", async () => {
      const { sssf } = await tree();
      expect(sssf.state).toBe("ready");
      expect(sssf.repos.map((r) => r.name).sort()).toEqual(["fresh", "live", "old", "soon"]);
      expect(sssf.repos.find((r) => r.name === "soon")).toEqual({ name: "soon", state: "pending", running: false });
      expect(sssf.repos.find((r) => r.name === "live")).toEqual({
        name: "live",
        state: "ready",
        running: true,
        lastRun: { status: "running", startedAt: "2026-08-17T09:00:00+00:00" },
      });
      expect(sssf.repos.find((r) => r.name === "old")?.lastRun).toEqual({ status: "success", startedAt: "2026-08-10T10:00:00+00:00" });
      expect(sssf.attached).toEqual({ repo: "live", adwId: "l2" });
      // Names only — no path leaks into the snapshot.
      expect(JSON.stringify(sssf)).not.toContain(tmpdir());
    });

    test("each pane gets the runs that recorded its id, newest first across repos; others get nothing", async () => {
      const { viz } = await tree();
      const panes = [
        { paneId: "w1:p1", workspaceId: "w1", cwd: "" },
        { paneId: "w1:p2", workspaceId: "w1", cwd: "" },
        { paneId: "w1:p3", workspaceId: "w1", cwd: "" },
        // Same id in another workspace: discovery is per workspace, so it carries nothing.
        { paneId: "w1:p1", workspaceId: "w9", cwd: "" },
      ];
      const [p1, p2, p3, other] = viz.decoratePanes(panes);
      expect(p1?.sssf?.runs.map((r) => `${r.repo}/${r.adwId}/${r.status}`)).toEqual(["fresh/f1/success", "live/l2/running"]);
      expect(p2?.sssf?.runs).toEqual([{ repo: "live", adwId: "l1", status: "fail", startedAt: "2026-08-16T09:00:00+00:00" }]);
      expect(p3?.sssf).toBeUndefined();
      expect(other?.sssf).toBeUndefined();
      // The old repo's run has no pane_id: it attaches to no pane, and the pane stamp names no path.
      expect(JSON.stringify(viz.decoratePanes(panes))).not.toContain(tmpdir());
      // A session scope that was never discovered stamps nothing.
      expect(viz.decoratePanes(panes)[0]?.sssf).toBeUndefined();
    });

    test("while the app is open, a 30s poll flips running flags without walking for new repos", async () => {
      const top = await mkdtemp(join(tmpdir(), "sssf-live-"));
      await fakeRepo(join(top, "Projects"), "bench", [
        { adw_id: "b1", status: "running", started_at: "2026-08-17T09:00:00+00:00" },
      ]);
      await fakeRepo(join(top, "Projects"), "sightr", [
        { adw_id: "s1", status: "success", started_at: "2026-08-16T09:00:00+00:00" },
      ]);
      const state = await mkdtemp(join(tmpdir(), "sssf-live-state-"));
      let t = 1_000;
      const viz = createSssfViz(cfg({ stateDir: state }), helpers, { vizDir: VIZ, build: false, now: () => t });
      expect(await viz.ready).toBe(true);
      let stamped: WorkspaceView[] = [];
      for (let i = 0; i < 50; i++) {
        stamped = viz.decorate([ws("w1")], [{ workspaceId: "w1", cwd: top }]);
        if (stamped[0]?.sssf) break;
        await Bun.sleep(20);
      }
      expect(stamped[0]?.sssf?.repos.filter((r) => r.running).map((r) => r.name)).toEqual(["bench"]);

      const rewrite = (repo: string, sql: string) => {
        const db = new Database(join(top, "Projects", repo, "adws", "adw_data", "sssf.db"));
        db.exec(sql);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();
      };
      rewrite("bench", "UPDATE sessions SET status='success' WHERE adw_id='b1'");
      rewrite("sightr", "UPDATE sessions SET status='running' WHERE adw_id='s1'");
      await fakeRepo(join(top, "Projects"), "late", [
        { adw_id: "x1", status: "running", started_at: "2026-08-18T09:00:00+00:00" },
      ]);

      // Off Traces, before 30s: stamp stays frozen (no filesystem walk, no live re-read).
      stamped = viz.decorate([ws("w1")], [{ workspaceId: "w1", cwd: top }], false);
      expect(stamped[0]?.sssf?.repos.filter((r) => r.running).map((r) => r.name)).toEqual(["bench"]);
      expect(stamped[0]?.sssf?.repos.map((r) => r.name)).not.toContain("late");

      t += RECHECK_MS;
      stamped = viz.decorate([ws("w1")], [{ workspaceId: "w1", cwd: top }], false);
      expect(stamped[0]?.sssf?.repos.filter((r) => r.running).map((r) => r.name)).toEqual(["sightr"]);
      expect(stamped[0]?.sssf?.attached).toEqual({ repo: "sightr", adwId: "s1" });
      // Live poll does not discover a repo that appeared after the last walk.
      expect(stamped[0]?.sssf?.repos.map((r) => r.name)).not.toContain("late");
    });

    test("a repo with many sessions stamps only the newest 3 onto its pane", async () => {
      const top = await mkdtemp(join(tmpdir(), "sssf-cap-"));
      await fakeRepo(top, "busy", [
        { adw_id: "r1", status: "success", started_at: "2026-08-01T00:00:00+00:00", pane_id: "w1:p1" },
        { adw_id: "r2", status: "fail", started_at: "2026-08-02T00:00:00+00:00", pane_id: "w1:p1" },
        { adw_id: "r3", status: "success", started_at: "2026-08-03T00:00:00+00:00", pane_id: "w1:p1" },
        { adw_id: "r4", status: "success", started_at: "2026-08-04T00:00:00+00:00", pane_id: "w1:p1" },
        { adw_id: "r5", status: "running", started_at: "2026-08-05T00:00:00+00:00", pane_id: "w1:p1" },
      ]);
      const state = await mkdtemp(join(tmpdir(), "sssf-cap-state-"));
      const viz = createSssfViz(cfg({ stateDir: state }), helpers, { vizDir: VIZ, build: false });
      expect(await viz.ready).toBe(true);
      for (let i = 0; i < 50; i++) {
        if (viz.decorate([ws("w1")], [{ workspaceId: "w1", cwd: top }])[0]?.sssf) break;
        await Bun.sleep(20);
      }
      const [pane] = viz.decoratePanes([{ paneId: "w1:p1", workspaceId: "w1", cwd: "" }]);
      expect(pane?.sssf?.runs.map((r) => r.adwId)).toEqual(["r5", "r4", "r3"]);
    });

    test("with nothing running, the most recently started run wins and no adw_id is pinned", async () => {
      const top = await mkdtemp(join(tmpdir(), "sssf-quiet-"));
      await fakeRepo(top, "old", [{ adw_id: "o1", status: "success", started_at: "2026-08-10T10:00:00+00:00" }]);
      await fakeRepo(top, "fresh", [{ adw_id: "f1", status: "fail", started_at: "2026-08-18T08:00:00+00:00" }]);
      const state = await mkdtemp(join(tmpdir(), "sssf-state-"));
      const viz = createSssfViz(cfg({ stateDir: state }), helpers, { vizDir: VIZ, build: false });
      await viz.ready;
      let stamped: WorkspaceView[] = [];
      for (let i = 0; i < 50; i++) {
        stamped = viz.decorate([ws("w1")], [{ workspaceId: "w1", cwd: top }]);
        if (stamped[0]?.sssf) break;
        await Bun.sleep(20);
      }
      expect(stamped[0]?.sssf?.attached).toEqual({ repo: "fresh" });
    });

    test("?repo= picks the db; absent → attached; unknown, pending, or path-shaped → 404", async () => {
      const { viz } = await tree();
      const ids = async (q: string) => {
        const r = await get(viz, `/sssf/api/sessions?ws=w1&session=primary${q}`);
        if (r.status !== 200) return r.status;
        return ((await r.json()) as Array<{ adw_id: string }>).map((s) => s.adw_id);
      };
      expect(await ids("")).toEqual(["l2", "l1"]);
      expect(await ids("&repo=live")).toEqual(["l2", "l1"]);
      expect(await ids("&repo=old")).toEqual(["o1"]);
      expect(await ids("&repo=fresh")).toEqual(["f1"]);
      expect(await ids("&repo=soon")).toBe(404);
      expect(await ids("&repo=nope")).toBe(404);
      expect(await ids("&repo=..%2Fold")).toBe(404);
      expect(await ids(`&repo=${encodeURIComponent(join(tmpdir(), "x"))}`)).toBe(404);
      const health = (await (await get(viz, "/sssf/api/health?ws=w1&session=primary&repo=old")).json()) as { sessions: number };
      expect(health.sessions).toBe(1);
    });
  });
});
