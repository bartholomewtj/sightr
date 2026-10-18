import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { v2AttachmentPath, type TurnItem } from "../../shared/v2/contracts.ts";
import type { Config } from "../config.ts";
import { parseClaudeTranscript } from "../journal/claude.ts";
import { createPaneQueue } from "../pane-queue.ts";
import type { EngineSnapshot } from "../state-engine.ts";
import { createProject, createThread, thread } from "../test/thread-fixtures.ts";
import {
  ATTACHMENT_CSP,
  attachmentResponse,
  createAttachmentReader,
  sniffImageType,
  type AttachmentDeps,
} from "./attachments.ts";
import type { TurnItemDraft } from "./events.ts";
import { createV2Gate } from "./herdr-floor.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";
import { entryItems, logTag, shortHash } from "./turn-items.ts";
import { createV2Routes } from "./v2-routes.ts";

// The attachment route against a real thread store and real files in a temp dir: a Claude log with a
// Read of a PNG, a screenshot (declared JPEG, really PNG), a paste and a lone image (the synthetic
// fixture), and a phone uploads dir.

const FIXTURE = readFileSync(join(import.meta.dir, "..", "journal", "fixtures", "claude-images.jsonl"), "utf8");
const PNG = Buffer.from(/"data":"([^"]+)"/.exec(FIXTURE)![1]!, "base64");
const UPLOAD = "w1_p-t1-mgx0a1-0123abcd.png";

let dir: string;
let logPath: string;
let uploadsDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sightr-attach-"));
  mkdirSync(join(dir, "sessions"));
  uploadsDir = join(dir, "state", "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  logPath = join(dir, "sessions", "log.jsonl");
  writeFileSync(logPath, FIXTURE);
  writeFileSync(join(dir, "sessions", "next.jsonl"), "{}\n");
  writeFileSync(join(uploadsDir, UPLOAD), PNG);
  writeFileSync(join(uploadsDir, "w1_p-t1-mgx0a1-0123abce.png"), "not an image at all");
  writeFileSync(join(dir, "state", "secret.png"), PNG);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A store holding the fixture's items (attachments referencing `logPath`), plus extra items. */
function storeWith(extra: TurnItemDraft[] = [], offsetPath = logPath): ThreadStore {
  const store = openThreadStore(":memory:", { now: () => 5_000, log: () => {} });
  store.append([createProject(), createThread(thread("t1")), createThread(thread("t2", { paneId: "w1:p-t2" }))]);
  const items = parseClaudeTranscript(FIXTURE, { byteOffset: 0 }).flatMap((e) =>
    entryItems(e, { threadId: "t1", runId: null, runOpen: false, createdAt: 1, updatedAt: 1, harness: "claude", logTag: logTag(logPath) }),
  );
  store.append(
    [...items, ...extra].map((item) => ({ type: "turn-item.updated" as const, threadId: item.threadId, payload: { item } })),
    { offsets: [{ threadId: "t1", path: offsetPath, offset: FIXTURE.length, size: FIXTURE.length, mtimeMs: 1, sessionKey: "id:x" }] },
  );
  return store;
}

const itemWith = (store: ThreadStore, pred: (i: TurnItem) => boolean): TurnItem => store.recentItems("t1", 50).find(pred)!;
const read = (store: ThreadStore) => itemWith(store, (i) => i.type === "dynamic_tool" && i.toolName === "Read");

const userItem = (id: string, attachments: Extract<TurnItem, { type: "user_message" }>["attachments"], threadId = "t1"): TurnItemDraft => ({
  id,
  threadId,
  runId: null,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  createdAt: 1,
  updatedAt: 1,
  type: "user_message",
  messageId: id,
  text: "",
  attachments,
});

function reader(store: ThreadStore, over: Partial<AttachmentDeps> = {}) {
  return createAttachmentReader({ store, uploadsDir, ...over });
}

describe("journal images", () => {
  test("a Read of a PNG is served from its log row, with hardening headers", async () => {
    const store = storeWith();
    const item = read(store);
    expect(item.type === "dynamic_tool" && item.attachments?.[0]).toMatchObject({ type: "image", name: "logo.png", path: "", mimeType: "image/png" });
    const res = attachmentResponse(await reader(store).load("t1", item.id, 0));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(ATTACHMENT_CSP);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  test("the type is sniffed from the bytes, not the log's claim (a 'jpeg' screenshot that is a PNG)", async () => {
    const store = storeWith();
    const shot = itemWith(store, (i) => i.type === "dynamic_tool" && i.toolName === "mcp__claude-in-chrome__computer");
    const result = await reader(store).load("t1", shot.id, 0);
    expect(result).toMatchObject({ ok: true, contentType: "image/png" });
  });

  test("a pasted image and a lone image are served from the user's rows", async () => {
    const store = storeWith();
    const users = store.recentItems("t1", 50).filter((i) => i.type === "user_message" && i.attachments.length > 0);
    expect(users).toHaveLength(2);
    for (const u of users) expect(await reader(store).load("t1", u.id, 0)).toMatchObject({ ok: true, contentType: "image/png" });
  });

  test("another thread's item, an unknown item, an index past the end: 404", async () => {
    const store = storeWith();
    const r = reader(store);
    expect(await r.load("t2", read(store).id, 0)).toMatchObject({ ok: false, status: 404 });
    expect(await r.load("nope", read(store).id, 0)).toMatchObject({ ok: false, status: 404 });
    expect(await r.load("t1", "no-such-item:0", 0)).toMatchObject({ ok: false, status: 404 });
    expect(await r.load("t1", read(store).id, 1)).toMatchObject({ ok: false, status: 404 });
  });

  test("a rewritten log (another row at the offset) is refused, not misread", async () => {
    const store = storeWith();
    const id = read(store).id;
    const rewritten = join(dir, "sessions", "log.jsonl");
    writeFileSync(rewritten, FIXTURE.replace(/c1000000-0000-4000-8000-000000000003/g, "c1000000-0000-4000-8000-00000000000f"));
    try {
      expect(await reader(store).load("t1", id, 0)).toMatchObject({ ok: false, status: 404, reason: "row-changed" });
      writeFileSync(rewritten, `x${FIXTURE}`);
      expect(await reader(store).load("t1", id, 0)).toMatchObject({ ok: false, status: 404 });
    } finally {
      writeFileSync(rewritten, FIXTURE);
    }
  });

  test("after the thread moves on to a sibling log, its older images still resolve", async () => {
    const store = storeWith([], join(dir, "sessions", "next.jsonl"));
    expect(await reader(store).load("t1", read(store).id, 0)).toMatchObject({ ok: true });
  });

  test("a reference to a log that is not the thread's or a sibling: 404", async () => {
    const outside = join(dir, "elsewhere.jsonl");
    writeFileSync(outside, FIXTURE);
    const store = storeWith([userItem("u-out", [{ type: "image", id: `j_${logTag(outside)}_0_0_x`, name: "x", path: "" }])]);
    expect(await reader(store).load("t1", "u-out", 0)).toMatchObject({ ok: false, status: 404 });
  });

  test("size caps: an image or a row over the cap is 413", async () => {
    const store = storeWith();
    expect(await reader(store, { maxBytes: 10 }).load("t1", read(store).id, 0)).toMatchObject({ ok: false, status: 413 });
    expect(await reader(store, { maxRowBytes: 64 }).load("t1", read(store).id, 0)).toMatchObject({ ok: false, status: 413 });
  });

  test("a logged image whose bytes are not a raster image (SVG) is 415", async () => {
    const svgLog = join(dir, "sessions", "svg.jsonl");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
    writeFileSync(svgLog, `${JSON.stringify({ uuid: "row-svg", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: svg } }] } })}\n`);
    const store = storeWith([userItem("u-svg", [{ type: "image", id: `j_${logTag(svgLog)}_0_0_${shortHash("row-svg")}`, name: "x", path: "" }])]);
    expect(await reader(store).load("t1", "u-svg", 0)).toMatchObject({ ok: false, status: 415 });
  });
});

describe("uploads", () => {
  test("a phone upload is served by its bridge-made name", async () => {
    const store = storeWith([userItem("u1", [{ type: "image", id: `u_${UPLOAD}`, name: UPLOAD, path: join(uploadsDir, UPLOAD) }])]);
    const res = attachmentResponse(await reader(store).load("t1", "u1", 0));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
  });

  test("a dispatch item's upload path (no id) works too", async () => {
    const store = storeWith([userItem("u2", [{ name: "photo.png", path: join(uploadsDir, UPLOAD) }])]);
    expect(await reader(store).load("t1", "u2", 0)).toMatchObject({ ok: true });
  });

  test("traversal: names outside the bridge's upload shape never reach the disk", async () => {
    const store = storeWith([
      userItem("t-a", [{ type: "image", id: "u_../secret.png", name: "a", path: "" }]),
      userItem("t-b", [{ name: "b", path: join(uploadsDir, "..", "secret.png") }]),
      userItem("t-c", [{ name: "c", path: "C:\\Windows\\win.ini" }]),
      userItem("t-d", [{ type: "image", id: "u_w1_p-t1-mgx0a1-0123abcd.png/../../secret.png", name: "d", path: "" }]),
    ]);
    for (const id of ["t-a", "t-b", "t-c", "t-d"]) expect(await reader(store).load("t1", id, 0)).toMatchObject({ ok: false, status: 404 });
  });

  test("an upload with an image name and text bytes is 415; a missing one 404", async () => {
    const store = storeWith([
      userItem("t-txt", [{ type: "image", id: "u_w1_p-t1-mgx0a1-0123abce.png", name: "x", path: "" }]),
      userItem("t-gone", [{ type: "image", id: "u_w1_p-t1-mgx0a1-0123abcf.png", name: "x", path: "" }]),
    ]);
    expect(await reader(store).load("t1", "t-txt", 0)).toMatchObject({ ok: false, status: 415 });
    expect(await reader(store).load("t1", "t-gone", 0)).toMatchObject({ ok: false, status: 404 });
    expect(await reader(store, { uploadsDir: null }).load("t1", "t-txt", 0)).toMatchObject({ ok: false, status: 404 });
  });
});

test("sniffImageType knows the four raster formats only", () => {
  expect(sniffImageType(PNG)).toBe("image/png");
  expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(sniffImageType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
  expect(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBP"))).toBe("image/webp");
  expect(sniffImageType(new TextEncoder().encode("<svg"))).toBeNull();
});

describe("the route", () => {
  async function routes(store: ThreadStore) {
    const gate = createV2Gate({ log: () => {} });
    await gate.check({ serverVersion: async () => "0.9.0" });
    return createV2Routes({
      cfg: { allowAnyHost: true, allowedOrigins: [], publicHosts: [], tailscaleHosts: [], trustedUser: "", deviceHeader: "", deviceAllowlist: [], stateDir: join(dir, "state") } as unknown as Config,
      store,
      gate,
      engine: { current: () => ({ agents: [], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }) as unknown as EngineSnapshot },
      activity: { noteSeen: () => false, noteUnseen: () => false },
      queue: createPaneQueue(),
    });
  }
  const call = (r: Awaited<ReturnType<typeof routes>>, path: string, init: RequestInit = {}) => {
    const req = new Request(`http://localhost${path}`, { ...init, headers: { host: "localhost", ...(init.headers ?? {}) } });
    return r.handle(req, new URL(req.url))!;
  };

  test("GET serves the image; the path helper builds the URL", async () => {
    const store = storeWith([userItem("u1", [{ type: "image", id: `u_${UPLOAD}`, name: UPLOAD, path: "" }])]);
    const r = await routes(store);
    const res = await call(r, v2AttachmentPath("t1", read(store).id, 0));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await call(r, v2AttachmentPath("t1", "u1", 0))).status).toBe(200);
    r.close();
  });

  test("other methods are refused; a bad segment is 400; an unknown item 404", async () => {
    const store = storeWith();
    const r = await routes(store);
    expect((await call(r, v2AttachmentPath("t1", read(store).id, 0), { method: "POST", headers: { origin: "http://localhost" } })).status).toBe(405);
    expect((await call(r, "/api/v2/thread/t1/item/%E0%A4%A/attachment/0")).status).toBe(400);
    expect((await call(r, v2AttachmentPath("t1", "nope", 0))).status).toBe(404);
    r.close();
  });

  test("a foreign Host is refused before anything is read", async () => {
    const store = storeWith();
    const r = await createV2Routes({
      cfg: { allowAnyHost: false, allowedOrigins: [], publicHosts: [], tailscaleHosts: [], trustedUser: "", deviceHeader: "", deviceAllowlist: [], stateDir: join(dir, "state") } as unknown as Config,
      store,
      gate: await (async () => {
        const g = createV2Gate({ log: () => {} });
        await g.check({ serverVersion: async () => "0.9.0" });
        return g;
      })(),
      engine: { current: () => ({ agents: [], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }) as unknown as EngineSnapshot },
      activity: { noteSeen: () => false, noteUnseen: () => false },
      queue: createPaneQueue(),
    });
    const req = new Request(`http://evil.example${v2AttachmentPath("t1", read(store).id, 0)}`, { headers: { host: "evil.example" } });
    const res = await r.handle(req, new URL(req.url))!;
    expect(res.status).toBe(403);
    r.close();
  });
});
