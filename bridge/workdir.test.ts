import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink, truncate, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readWorkRoot } from "./config.ts";
import { browserEmbedKind, browserOpenCsp, browserOpenType, BROWSER_HTML_CSP, createWorkdir, isFilesOpenPath, isRefusedName, parseFilesOpenRel, parseRelPath, PREVIEW_CAP_BYTES, DOWNLOAD_CAP_BYTES } from "./workdir.ts";
import type { Config } from "./config.ts";
import { CAN_SYMLINK } from "./platform-support.ts";
import { SILENT_AUDIT } from "./audit.ts";

const cfg = (workRoot: string): Config => ({ workRoot, socketPath: "", port: 1, host: "127.0.0.1", allowNonLoopbackBind: false, pollMs: 1, pollIdleMs: 1, notifyDelayMs: 0, readLines: 1, transcript: false, journalRoots: { claude: [], pi: [], grok: [] }, submitKeys: [], commandsFile: "", keysFile: "", trustedUser: "", trustedUserOptional: false, deviceHeader: "", deviceAllowlist: [], allowedOrigins: [], publicHosts: [], pushAllowedHosts: [], tailscaleHosts: [], allowAnyHost: false, vapidPublic: "", vapidPrivate: "", vapidSubject: "", stateDir: "", skipServe: false, audit: false, auditContent: "preview", beacons: false });
const helpers = { paneCwd: () => null, guard: () => null, json: (v: unknown, _e: string | null, status = 200) => new Response(JSON.stringify(v), { status }), text: (v: string, status: number) => new Response(v, { status }), failureText: () => "files failed", secure: (r: Response) => r, contentTypes: {}, requireJsonBody: (req: Request) => req.headers.get("content-type")?.startsWith("application/json") ? null : new Response("expected application/json", { status: 415 }), auditFor: () => SILENT_AUDIT };

async function mtimeOf(w: ReturnType<typeof createWorkdir>, path: string): Promise<number> {
  const j = await (await w.handle(new Request(`http://x/api/files?path=${path}`), new URL(`http://x/api/files?path=${path}`))).json() as { mtimeMs: number };
  return j.mtimeMs;
}
function saveReq(path: string, text: string, mtimeMs: number, extra: { headers?: Record<string, string> } = {}) {
  return new Request("http://x/api/files/save", { method: "POST", headers: { "content-type": "application/json", ...extra.headers }, body: JSON.stringify({ path, text, mtimeMs }) });
}

function readStoreZip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  let i = 0;
  while (i + 30 <= bytes.length && view.getUint32(i, true) === 0x04034b50) {
    const size = view.getUint32(i + 22, true);
    const nameLen = view.getUint16(i + 26, true);
    const extraLen = view.getUint16(i + 28, true);
    const name = dec.decode(bytes.subarray(i + 30, i + 30 + nameLen));
    const start = i + 30 + nameLen + extraLen;
    out.set(name, dec.decode(bytes.subarray(start, start + size)));
    i = start + size;
  }
  return out;
}

describe("workdir", () => {
  test("parses roots and refuses unsafe names", () => {
    expect(readWorkRoot({ SIGHTR_WORK_ROOT: " " })).toBe("");
    expect(readWorkRoot({ SIGHTR_WORK_ROOT: "rel/dir" })).toBe(resolve("rel/dir"));
    for (const n of [".env", ".git", "node_modules", "config", "server.pem", "id_rsa", "__pycache__", "adws"]) expect(isRefusedName(n)).toBe(true);
    expect(parseRelPath("src/adws")).toBeNull();
    expect(parseRelPath("a/../b")).toBeNull();
    expect(parseRelPath("C:\\x")).toBeNull();
    expect(parseRelPath("a//b")).toBeNull();
    expect(parseRelPath("a/b")).toEqual(["a", "b"]);
  });
  test("lists safely, previews text, and hides typed refusals", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-"));
    try {
      await mkdir(join(root, "sub")); await mkdir(join(root, "node_modules")); await mkdir(join(root, "config")); await mkdir(join(root, "adws"));
      await writeFile(join(root, "a.txt"), "hello"); await writeFile(join(root, ".env"), "secret");
      const w = createWorkdir(cfg(root), helpers);
      const listing = JSON.parse(await (await w.handle(new Request("http://x/api/files"), new URL("http://x/api/files"))).text());
      expect(listing.entries.map((e: { name: string }) => e.name)).toEqual(["sub", "a.txt"]);
      expect(listing.entries.map((e: { repo?: boolean }) => e.repo)).toEqual([undefined, undefined]);
      const hidden = await w.handle(new Request("http://x/api/files?path=.env"), new URL("http://x/api/files?path=.env"));
      expect(hidden.status).toBe(404);
      const hiddenNode = await w.handle(new Request("http://x/api/files?path=node_modules/pkg/index.js"), new URL("http://x/api/files?path=node_modules/pkg/index.js"));
      expect(hiddenNode.status).toBe(404);
      const hiddenAdws = await w.handle(new Request("http://x/api/files?path=adws/raw.jsonl"), new URL("http://x/api/files?path=adws/raw.jsonl"));
      expect(hiddenAdws.status).toBe(404);
      const file = await w.handle(new Request("http://x/api/files?path=a.txt"), new URL("http://x/api/files?path=a.txt"));
      expect((await file.json()).text).toBe("hello");
      expect(PREVIEW_CAP_BYTES).toBe(512 * 1024);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("searches names, caps previews, and downloads safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-search-"));
    try {
      await mkdir(join(root, "node_modules")); await writeFile(join(root, "Alpha.txt"), "A".repeat(PREVIEW_CAP_BYTES + 1)); await writeFile(join(root, "binary.bin"), new Uint8Array([0, 1])); await writeFile(join(root, "node_modules", "Alpha.txt"), "hidden");
      const w = createWorkdir(cfg(root), helpers);
      const s = await (await w.handle(new Request("http://x/api/files/search?q=alpha"), new URL("http://x/api/files/search?q=alpha"))).json(); expect(s.results).toHaveLength(1);
      const short = await (await w.handle(new Request("http://x/api/files/search?q=a"), new URL("http://x/api/files/search?q=a"))).json(); expect(short.results).toEqual([]);
      const big = await (await w.handle(new Request("http://x/api/files?path=Alpha.txt"), new URL("http://x/api/files?path=Alpha.txt"))).json(); expect(big.truncated).toBe(true); expect(big.text.length).toBe(PREVIEW_CAP_BYTES);
      const bin = await (await w.handle(new Request("http://x/api/files?path=binary.bin"), new URL("http://x/api/files?path=binary.bin"))).json(); expect(bin.binary).toBe(true); expect(bin.text).toBeUndefined();
      const dl = await w.handle(new Request("http://x/api/files/download?path=Alpha.txt"), new URL("http://x/api/files/download?path=Alpha.txt")); expect(dl.headers.get("content-disposition")).toContain("attachment"); expect(dl.headers.get("content-length")).toBe(String(PREVIEW_CAP_BYTES + 1));
      expect(DOWNLOAD_CAP_BYTES).toBe(100 * 1024 * 1024);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("zips a folder, skips refusals, and caps by total size", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-zip-"));
    const outside = await mkdtemp(join(tmpdir(), "sightr-workdir-zip-out-"));
    try {
      await mkdir(join(root, "src", "lib"), { recursive: true }); await mkdir(join(root, "src", "node_modules", "pkg"), { recursive: true }); await mkdir(join(root, "src", "config"));
      await writeFile(join(root, "src", "a.txt"), "hello"); await writeFile(join(root, "src", "lib", "b.ts"), "x");
      await writeFile(join(root, "src", "node_modules", "pkg", "index.js"), "hidden"); await writeFile(join(root, "src", ".env"), "secret"); await writeFile(join(root, "src", "config", "x"), "hidden");
      const w = createWorkdir(cfg(root), helpers);
      const response = await w.handle(new Request("http://x/api/files/download?path=src"), new URL("http://x/api/files/download?path=src"));
      const bytes = new Uint8Array(await response.arrayBuffer()); const body = new TextDecoder().decode(bytes); const zip = readStoreZip(bytes);
      expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("application/zip");
      expect(response.headers.get("content-disposition")).toContain("attachment"); expect(response.headers.get("content-disposition")).toContain("src.zip"); expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''src.zip");
      expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("x-content-type-options")).toBe("nosniff"); expect(response.headers.get("content-length")).toBe(String(bytes.length));
      expect(zip.get("src/a.txt")).toBe("hello"); expect(zip.get("src/lib/b.ts")).toBe("x"); expect([...zip.keys()].some((name) => name.startsWith("src/node_modules/") || name.startsWith("src/config/") || name === "src/.env")).toBe(false); expect(body).not.toContain("secret");
      expect((await w.handle(new Request("http://x/api/files/download?path="), new URL("http://x/api/files/download?path="))).status).toBe(404);

      await mkdir(join(root, "src", "adws"), { recursive: true });
      await writeFile(join(root, "src", "adws", "raw.jsonl"), "x");
      await truncate(join(root, "src", "adws", "raw.jsonl"), DOWNLOAD_CAP_BYTES + 1);
      const skippedFactory = await w.handle(new Request("http://x/api/files/download?path=src"), new URL("http://x/api/files/download?path=src"));
      expect(skippedFactory.status).toBe(200);
      expect([...readStoreZip(new Uint8Array(await skippedFactory.arrayBuffer())).keys()].some((name) => name.includes("adws"))).toBe(false);

      await mkdir(join(root, "src", "dump"), { recursive: true });
      await writeFile(join(root, "src", "dump", "huge.bin"), "x");
      await truncate(join(root, "src", "dump", "huge.bin"), DOWNLOAD_CAP_BYTES + 1);
      const trimmed = await w.handle(new Request("http://x/api/files/download?path=src"), new URL("http://x/api/files/download?path=src"));
      const trimmedZip = readStoreZip(new Uint8Array(await trimmed.arrayBuffer()));
      expect(trimmed.status).toBe(200);
      expect(trimmedZip.get("src/a.txt")).toBe("hello");
      expect(trimmedZip.has("src/dump/huge.bin")).toBe(false);
      expect(trimmedZip.get("src/SIGHTR-SKIPPED.txt")).toContain("dump/");

      if (CAN_SYMLINK) {
        await writeFile(join(outside, "outside.txt"), "outside-secret"); await symlink(join(outside, "outside.txt"), join(root, "src", "link"));
        const linked = await w.handle(new Request("http://x/api/files/download?path=src"), new URL("http://x/api/files/download?path=src")); const linkedBytes = new Uint8Array(await linked.arrayBuffer());
        const linkedZip = readStoreZip(linkedBytes); expect(linkedZip.has("src/link")).toBe(false); expect(new TextDecoder().decode(linkedBytes)).not.toContain("outside-secret");
      }

      await mkdir(join(root, "fat"));
      const half = Math.floor(DOWNLOAD_CAP_BYTES * 0.6);
      await writeFile(join(root, "fat", "a.bin"), "x"); await truncate(join(root, "fat", "a.bin"), half);
      await writeFile(join(root, "fat", "b.bin"), "x"); await truncate(join(root, "fat", "b.bin"), half);
      const over = await w.handle(new Request("http://x/api/files/download?path=fat"), new URL("http://x/api/files/download?path=fat")); const overBytes = new Uint8Array(await over.arrayBuffer());
      expect(over.status).toBe(413); expect(overBytes.slice(0, 4)).not.toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  test("omits the largest child directory when siblings together exceed the cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-zip-siblings-"));
    try {
      await mkdir(join(root, "pair", "keep"), { recursive: true });
      await mkdir(join(root, "pair", "drop"), { recursive: true });
      await writeFile(join(root, "pair", "keep", "ok.bin"), "x");
      await truncate(join(root, "pair", "keep", "ok.bin"), Math.floor(DOWNLOAD_CAP_BYTES * 0.4));
      await writeFile(join(root, "pair", "drop", "fat.bin"), "x");
      await truncate(join(root, "pair", "drop", "fat.bin"), Math.floor(DOWNLOAD_CAP_BYTES * 0.7));
      await writeFile(join(root, "pair", "readme.txt"), "hi");
      const w = createWorkdir(cfg(root), helpers);
      const response = await w.handle(new Request("http://x/api/files/download?path=pair"), new URL("http://x/api/files/download?path=pair"));
      const zip = readStoreZip(new Uint8Array(await response.arrayBuffer()));
      expect(response.status).toBe(200);
      expect(zip.get("pair/readme.txt")).toBe("hi");
      expect(zip.has("pair/keep/ok.bin")).toBe(true);
      expect(zip.has("pair/drop/fat.bin")).toBe(false);
      expect(zip.get("pair/SIGHTR-SKIPPED.txt")).toContain("drop/");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("searches caps results and refuses downloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-cap-"));
    try {
      for (let i = 0; i < 201; i++) await writeFile(join(root, `match-${i}.txt`), "x");
      const w = createWorkdir(cfg(root), helpers);
      const capped = await (await w.handle(new Request("http://x/api/files/search?q=match"), new URL("http://x/api/files/search?q=match"))).json();
      expect(capped.results).toHaveLength(200); expect(capped.truncated).toBe(true);
      await writeFile(join(root, "large.bin"), "x"); await truncate(join(root, "large.bin"), DOWNLOAD_CAP_BYTES + 1);
      const large = await w.handle(new Request("http://x/api/files/download?path=large.bin"), new URL("http://x/api/files/download?path=large.bin")); expect(large.status).toBe(413);
      const refused = await w.handle(new Request("http://x/api/files/download?path=config/x"), new URL("http://x/api/files/download?path=config/x")); expect(refused.status).toBe(404);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects symlinks outside the root", async () => {
    if (!CAN_SYMLINK) return;
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-link-")); const outside = await mkdtemp(join(tmpdir(), "sightr-workdir-out-"));
    try { await writeFile(join(outside, "secret.txt"), "outside-secret"); await symlink(join(outside, "secret.txt"), join(root, "link")); const w = createWorkdir(cfg(root), helpers); const response = await w.handle(new Request("http://x/api/files?path=link"), new URL("http://x/api/files?path=link")); expect(response.status).toBe(404); expect(await response.text()).not.toContain("outside-secret"); } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  test("deletes an editable text file with a write gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-delete-"));
    try {
      await writeFile(join(root, "a.txt"), "hello");
      const w = createWorkdir(cfg(root), helpers);
      const req = new Request("http://x/api/files/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "a.txt" }) });
      const res = await w.handle(req, new URL(req.url));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const listing = await (await w.handle(new Request("http://x/api/files"), new URL("http://x/api/files"))).json() as { entries: { name: string }[] };
      expect(listing.entries.map((e) => e.name)).not.toContain("a.txt");
      expect((await w.handle(new Request("http://x/api/files?path=a.txt"), new URL("http://x/api/files?path=a.txt"))).status).toBe(404);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects binary, directories, and refused paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-delete-refuse-"));
    try {
      await writeFile(join(root, "bin"), new Uint8Array([0, 1])); await mkdir(join(root, "sub")); await writeFile(join(root, ".env"), "secret");
      const w = createWorkdir(cfg(root), helpers);
      const post = (path: string) => { const req = new Request("http://x/api/files/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }); return w.handle(req, new URL(req.url)); };
      expect((await post("bin")).status).toBe(404); expect((await post("sub")).status).toBe(404); expect((await post(".env")).status).toBe(404);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("covers editable-file deletion refusal and error contracts", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-delete-full-"));
    try {
      await mkdir(join(root, "node_modules")); await mkdir(join(root, "config")); await mkdir(join(root, "adws")); await mkdir(join(root, "sub")); await mkdir(join(root, "src"));
      for (const [name, value] of [[".env", "secret"], ["node_modules/x.js", "hidden"], ["config/x", "hidden"], ["adws/x", "hidden"], ["id_rsa", "key"]] as const) await writeFile(join(root, name), value);
      await writeFile(join(root, "sub/child.txt"), "child"); await writeFile(join(root, "src/notes.md"), "hello");
      const post = (path: string, hs: Record<string, string> = { "content-type": "application/json" }, body: unknown = { path }) => { const req = new Request("http://x/api/files/delete", { method: "POST", headers: hs, body: hs["content-type"] ? JSON.stringify(body) : undefined }); return createWorkdir(cfg(root), helpers).handle(req, new URL(req.url)); };
      for (const path of [".env", "node_modules/x.js", "config/x", "adws/x", "id_rsa", "sub", "", "../outside", "C:\\x"]) expect((await post(path)).status).toBe(404);
      expect(await Bun.file(join(root, ".env")).text()).toBe("secret");
      for (const [name, value] of [["node_modules/x.js", "hidden"], ["config/x", "hidden"], ["adws/x", "hidden"], ["id_rsa", "key"]] as const) expect(await Bun.file(join(root, name)).text()).toBe(value);
      expect(await Bun.file(join(root, "sub", "child.txt")).exists()).toBe(true); expect(await Bun.file(join(root, "src/notes.md")).text()).toBe("hello");
      await writeFile(join(root, "binary"), new Uint8Array([0, 1])); expect((await post("binary")).status).toBe(404); expect(await Bun.file(join(root, "binary")).exists()).toBe(true); expect((await post("missing.txt")).status).toBe(404);
      expect((await createWorkdir(cfg(root), helpers).handle(new Request("http://x/api/files/delete"), new URL("http://x/api/files/delete"))).status).toBe(405);
      const put = new Request("http://x/api/files/delete", { method: "PUT" }); expect((await createWorkdir(cfg(root), helpers).handle(put, new URL(put.url))).status).toBe(405);
      expect((await post("src/notes.md", {})).status).toBe(415); expect((await post("src/notes.md", { "content-type": "application/json" }, {})).status).toBe(400); expect((await post("src/notes.md", { "content-type": "application/json" }, { path: 1 })).status).toBe(400);
      const denied = createWorkdir(cfg(root), { ...helpers, guard: (_req, _cfg, level) => level === "write" ? new Response("device not authorised", { status: 403 }) : null });
      const deniedReq = new Request("http://x/api/files/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "src/notes.md" }) }); expect((await denied.handle(deniedReq, new URL(deniedReq.url))).status).toBe(403); expect(await Bun.file(join(root, "src/notes.md")).text()).toBe("hello"); const read = await denied.handle(new Request("http://x/api/files?path=src/notes.md"), new URL("http://x/api/files?path=src/notes.md")); expect(read.status).toBe(200); expect((await read.json()).text).toBe("hello");
      const enoent = createWorkdir(cfg(root), { ...helpers, unlink: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } }); const er = await enoent.handle(new Request("http://x/api/files/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "src/notes.md" }) }), new URL("http://x/api/files/delete")); expect(er.status).toBe(404);
      const cases = ["EPERM", "EBUSY", "EACCES"];
      for (const code of cases) { const busy = createWorkdir(cfg(root), { ...helpers, unlink: async () => { throw Object.assign(new Error("busy"), { code }); } }); const response = await busy.handle(new Request("http://x/api/files/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "src/notes.md" }) }), new URL("http://x/api/files/delete")); expect(response.status).toBe(409); expect(await response.json()).toEqual({ ok: false, error: "file is in use" }); expect(await Bun.file(join(root, "src/notes.md")).text()).toBe("hello"); }
      const unknown = createWorkdir(cfg(root), { ...helpers, unlink: async () => { throw Object.assign(new Error("bad"), { code: "UNKNOWN" }); } }); const ur = await unknown.handle(new Request("http://x/api/files/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "src/notes.md" }) }), new URL("http://x/api/files/delete")); expect(ur.status).toBe(500); expect(await ur.text()).toBe("files failed");
      const broken = createWorkdir(cfg(root), { ...helpers, lstat: async () => { throw new Error("boom"); } }); const br = await broken.handle(new Request("http://x/api/files/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "src/notes.md" }) }), new URL("http://x/api/files/delete")); expect(br.status).toBe(500); expect(await br.text()).toBe("files failed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("deletes empty and truncated text and nested files", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-delete-text-"));
    try {
      await writeFile(join(root, "empty"), "");
      await writeFile(join(root, "large"), "A".repeat(PREVIEW_CAP_BYTES + 1));
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src/notes.md"), "hello");
      const w = createWorkdir(cfg(root), helpers);
      const del = (path: string) => w.handle(new Request("http://x/api/files/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }), new URL("http://x/api/files/delete"));
      expect((await del("empty")).status).toBe(200);
      expect((await del("large")).status).toBe(200);
      const nested = await del("src/notes.md");
      expect(nested.status).toBe(200);
      expect(await nested.json()).toEqual({ ok: true });
      const srcListing = await (await w.handle(new Request("http://x/api/files?path=src"), new URL("http://x/api/files?path=src"))).json() as { entries: { name: string }[] };
      expect(srcListing.entries.map((e) => e.name)).not.toContain("notes.md");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("preserves targets when deleting typed symlinks", async () => {
    if (!CAN_SYMLINK) return; const root = await mkdtemp(join(tmpdir(), "sightr-workdir-delete-link-")); const outside = await mkdtemp(join(tmpdir(), "sightr-workdir-delete-out-"));
    try { await writeFile(join(root, "a.txt"), "hello"); await writeFile(join(outside, "secret.txt"), "outside-secret"); await symlink(join(root, "a.txt"), join(root, "inside")); await symlink(join(outside, "secret.txt"), join(root, "outside")); const w = createWorkdir(cfg(root), helpers); const del = (path: string) => w.handle(new Request("http://x/api/files/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }), new URL("http://x/api/files/delete")); expect((await del("inside")).status).toBe(404); expect((await del("outside")).status).toBe(404); expect(await Bun.file(join(root, "a.txt")).text()).toBe("hello"); expect(await Bun.file(join(outside, "secret.txt")).text()).toBe("outside-secret"); } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  test("saves editable text with mtime and safe error contracts", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-save-"));
    try {
      await mkdir(join(root, "src")); await writeFile(join(root, "src/notes.md"), "hello");
      const w = createWorkdir(cfg(root), helpers);
      const mtime = (await (await w.handle(new Request("http://x/api/files?path=src/notes.md"), new URL("http://x/api/files?path=src/notes.md"))).json()).mtimeMs;
      const save = (path: string, text: string, stamp: unknown = mtime, hs: Record<string, string> = { "content-type": "application/json" }) => {
        const req = new Request("http://x/api/files/save", { method: "POST", headers: hs, body: hs["content-type"] ? JSON.stringify({ path, text, mtimeMs: stamp }) : undefined });
        return w.handle(req, new URL(req.url));
      };
      let response = await save("src/notes.md", "updated"); expect(response.status).toBe(200); expect(await Bun.file(join(root, "src/notes.md")).text()).toBe("updated");
      const next = await response.json(); expect(next.ok).toBe(true); expect(next.size).toBe(7);
      response = await save("src/notes.md", "again", next.mtimeMs); expect(response.status).toBe(200);
      const before = await Bun.file(join(root, "src/notes.md")).text();
      for (const [path, text] of [[".env", "secret"], ["config/x", "no"], ["adws/x", "no"], ["node_modules/x", "no"], ["id_rsa", "key"], ["../outside", "no"], ["C:\\x", "no"], ["", "no"], ["missing", "no"]] as const) { const r = await save(path, text); expect(r.status).toBe(404); }
      await writeFile(join(root, "bin"), new Uint8Array([0, 1])); await mkdir(join(root, "folder"));
      expect((await save("bin", "x")).status).toBe(404); expect((await save("folder", "x")).status).toBe(404);
      expect((await save("src/notes.md", "stale", 1)).status).toBe(409); expect(await Bun.file(join(root, "src/notes.md")).text()).toBe(before);
      await writeFile(join(root, "large"), "A".repeat(PREVIEW_CAP_BYTES + 1));
      const largeMtime = (await (await w.handle(new Request("http://x/api/files?path=large"), new URL("http://x/api/files?path=large"))).json()).mtimeMs;
      expect((await save("large", "x", largeMtime)).status).toBe(413);
      expect((await save("src/notes.md", "x", next.mtimeMs, {})).status).toBe(415);
      expect((await save("src/notes.md", "x", null, { "content-type": "application/json" })).status).toBe(400);
      const denied = createWorkdir(cfg(root), { ...helpers, guard: (_req, _cfg, level) => level === "write" ? new Response("denied", { status: 403 }) : null });
      const deniedReq = new Request("http://x/api/files/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "src/notes.md", text: "x", mtimeMs: next.mtimeMs }) });
      expect((await denied.handle(deniedReq, new URL(deniedReq.url))).status).toBe(403);
      for (const code of ["EPERM", "EBUSY", "EACCES"] as const) {
        const busy = createWorkdir(cfg(root), { ...helpers, writeNamed: async () => { throw Object.assign(new Error("busy"), { code }); } });
        const current = (await (await busy.handle(new Request("http://x/api/files?path=src/notes.md"), new URL("http://x/api/files?path=src/notes.md"))).json()).mtimeMs;
        const r = await busy.handle(new Request("http://x/api/files/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "src/notes.md", text: "x", mtimeMs: current }) }), new URL("http://x/api/files/save"));
        expect(r.status).toBe(409); expect(await r.json()).toEqual({ ok: false, error: "file is in use" }); expect(await Bun.file(join(root, "src/notes.md")).text()).toBe("again");
      }
      const injected = createWorkdir(cfg(root), { ...helpers, writeNamed: async (path, text) => { expect(path).toBe(join(root, "src/notes.md")); expect(text).toBe("named"); } });
      const injectedMtime = (await (await injected.handle(new Request("http://x/api/files?path=src/notes.md"), new URL("http://x/api/files?path=src/notes.md"))).json()).mtimeMs;
      expect((await injected.handle(new Request("http://x/api/files/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "src/notes.md", text: "named", mtimeMs: injectedMtime }) }), new URL("http://x/api/files/save"))).status).toBe(200);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  describe("save contract table", () => {
    test("handles empty, zero-byte, and NUL text", async () => {
      const root = await mkdtemp(join(tmpdir(), "sightr-save-contract-"));
      try {
        await writeFile(join(root, "empty.txt"), "hello"); await writeFile(join(root, "zero.txt"), "");
        const w = createWorkdir(cfg(root), helpers);
        let r = await w.handle(saveReq("empty.txt", "", await mtimeOf(w, "empty.txt")), new URL("http://x/api/files/save")); expect(r.status).toBe(200); expect((await Bun.file(join(root, "empty.txt")).size)).toBe(0);
        r = await w.handle(saveReq("zero.txt", "x", await mtimeOf(w, "zero.txt")), new URL("http://x/api/files/save")); expect(r.status).toBe(200); expect(await Bun.file(join(root, "zero.txt")).text()).toBe("x");
        r = await w.handle(saveReq("zero.txt", "ok\u0000x", await mtimeOf(w, "zero.txt")), new URL("http://x/api/files/save")); expect(r.status).toBe(200); expect(new Uint8Array(await Bun.file(join(root, "zero.txt")).arrayBuffer())).toEqual(new TextEncoder().encode("ok\u0000x"));
      } finally { await rm(root, { recursive: true, force: true }); }
    });
    test("refuses unsafe, missing, directory, and binary targets without changing bytes", async () => {
      const root = await mkdtemp(join(tmpdir(), "sightr-save-refuse-")); const outside = await mkdtemp(join(tmpdir(), "sightr-save-out-"));
      try {
        await mkdir(join(root, "node_modules")); await mkdir(join(root, "config")); await mkdir(join(root, "adws")); await mkdir(join(root, "folder")); await writeFile(join(root, "folder", "child"), "child");
        const fixtures: Record<string, Uint8Array> = {}; for (const [p, b] of [[".env", "secret"], ["node_modules/x.js", "hidden"], ["config/x", "cfg"], ["adws/x", "adw"], ["id_rsa", "key"], ["binary", "\x00\x01"]] as const) { await writeFile(join(root, p), b); fixtures[p] = new Uint8Array(await Bun.file(join(root, p)).arrayBuffer()); }
        await writeFile(join(outside, "outside"), "outside"); const w = createWorkdir(cfg(root), helpers);
        for (const p of Object.keys(fixtures).concat(["nope.txt", "../outside", "C:\\x"])) { const target = p === "../outside" ? join(outside, "outside") : join(root, p); const before = await Bun.file(target).arrayBuffer().catch(() => new ArrayBuffer(0)); const r = await w.handle(saveReq(p, "changed", 1), new URL("http://x/api/files/save")); expect(r.status).toBe(404); expect(new Uint8Array(await Bun.file(target).arrayBuffer().catch(() => new ArrayBuffer(0)))).toEqual(new Uint8Array(before)); }
        const directoryBefore = await Bun.file(join(root, "folder", "child")).arrayBuffer(); const directoryResponse = await w.handle(saveReq("folder", "changed", 1), new URL("http://x/api/files/save")); expect(directoryResponse.status).toBe(404); expect(new Uint8Array(await Bun.file(join(root, "folder", "child")).arrayBuffer())).toEqual(new Uint8Array(directoryBefore));
        const emptyResponse = await w.handle(saveReq("", "changed", 1), new URL("http://x/api/files/save")); expect(emptyResponse.status).toBe(404); expect((await stat(root)).isDirectory()).toBe(true);
      } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
    });
    test("rejects oversized files and bodies without changing bytes", async () => {
      const root = await mkdtemp(join(tmpdir(), "sightr-save-size-")); try { await writeFile(join(root, "large"), "A".repeat(PREVIEW_CAP_BYTES + 1)); await writeFile(join(root, "small"), "hello"); const w = createWorkdir(cfg(root), helpers); const lm = await mtimeOf(w, "large"); let r = await w.handle(saveReq("large", "x", lm), new URL("http://x/api/files/save")); expect(r.status).toBe(413); expect(await r.json()).toEqual({ error: "file too large" }); expect((await Bun.file(join(root, "large")).size)).toBe(PREVIEW_CAP_BYTES + 1); r = await w.handle(saveReq("small", "B".repeat(PREVIEW_CAP_BYTES + 1), await mtimeOf(w, "small")), new URL("http://x/api/files/save")); expect(r.status).toBe(413); expect(await r.json()).toEqual({ error: "file too large" }); expect(await Bun.file(join(root, "small")).text()).toBe("hello"); } finally { await rm(root, { recursive: true, force: true }); }
    });
    test("enforces methods, body fields, stale versions, and read-only guard", async () => {
      const root = await mkdtemp(join(tmpdir(), "sightr-save-errors-")); try { await writeFile(join(root, "a.txt"), "hello"); const w = createWorkdir(cfg(root), helpers); const req = (method: string, body?: unknown) => new Request("http://x/api/files/save", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); expect((await w.handle(req("GET"), new URL("http://x/api/files/save"))).status).toBe(405); expect((await w.handle(req("PUT"), new URL("http://x/api/files/save"))).status).toBe(405); for (const body of [{}, { path: 1 }]) { const r = await w.handle(req("POST", body), new URL("http://x/api/files/save")); expect(r.status).toBe(400); expect(await r.text()).toMatch(/path required|bad body/); } const originalBytes = new Uint8Array(await Bun.file(join(root, "a.txt")).arrayBuffer());
      let r = await w.handle(req("POST", { path: "a.txt" }), new URL("http://x/api/files/save")); expect(r.status).toBe(400); expect(await r.text()).toBe("text required"); expect(new Uint8Array(await Bun.file(join(root, "a.txt")).arrayBuffer())).toEqual(originalBytes);
      r = await w.handle(req("POST", { path: "a.txt", text: "x" }), new URL("http://x/api/files/save")); expect(r.status).toBe(400); expect(await r.text()).toBe("mtimeMs required"); expect(new Uint8Array(await Bun.file(join(root, "a.txt")).arrayBuffer())).toEqual(originalBytes);
      r = await w.handle(req("POST", { path: "a.txt", text: "x", mtimeMs: "1" }), new URL("http://x/api/files/save")); expect(r.status).toBe(400); expect(await r.text()).toBe("mtimeMs required"); expect(new Uint8Array(await Bun.file(join(root, "a.txt")).arrayBuffer())).toEqual(originalBytes); r = await w.handle(saveReq("a.txt", "x", 1), new URL("http://x/api/files/save")); expect(r.status).toBe(409); expect(await r.json()).toEqual({ ok: false, error: "file changed" }); expect(await Bun.file(join(root, "a.txt")).text()).toBe("hello"); const denied = createWorkdir(cfg(root), { ...helpers, guard: (_req, _cfg, level) => level === "write" ? new Response("denied", { status: 403 }) : null }); r = await denied.handle(saveReq("a.txt", "x", await mtimeOf(denied, "a.txt")), new URL("http://x/api/files/save")); expect(r.status).toBe(403); const read = await denied.handle(new Request("http://x/api/files?path=a.txt"), new URL("http://x/api/files?path=a.txt")); expect(read.status).toBe(200); expect((await read.json()).text).toBe("hello"); } finally { await rm(root, { recursive: true, force: true }); }
    });
    test("saves nested files and maps injected failures", async () => {
      const root = await mkdtemp(join(tmpdir(), "sightr-save-inject-")); try { await mkdir(join(root, "src")); await writeFile(join(root, "a.txt"), "hello"); await writeFile(join(root, "src/notes.md"), "hello"); const w = createWorkdir(cfg(root), helpers); let r = await w.handle(saveReq("a.txt", "world", await mtimeOf(w, "a.txt")), new URL("http://x/api/files/save")); expect(r.status).toBe(200); expect(await Bun.file(join(root, "a.txt")).text()).toBe("world"); r = await w.handle(saveReq("src/notes.md", "new", await mtimeOf(w, "src/notes.md")), new URL("http://x/api/files/save")); expect(r.status).toBe(200); expect(await Bun.file(join(root, "src/notes.md")).text()).toBe("new");
        const originalBytes = new Uint8Array(await Bun.file(join(root, "a.txt")).arrayBuffer());
        for (const code of ["ENOENT", "ELOOP", "UNKNOWN"] as const) { const x = createWorkdir(cfg(root), { ...helpers, writeNamed: async () => { throw Object.assign(new Error(code), { code }); } }); const q = await x.handle(saveReq("a.txt", "x", await mtimeOf(x, "a.txt")), new URL("http://x/api/files/save")); expect(q.status).toBe(code === "UNKNOWN" ? 500 : 404); if (code === "ELOOP") expect(await q.json()).toEqual({ error: "not found" }); if (code === "UNKNOWN") expect(await q.text()).toBe("files failed"); expect(new Uint8Array(await Bun.file(join(root, "a.txt")).arrayBuffer())).toEqual(originalBytes); }
        const broken = createWorkdir(cfg(root), { ...helpers, lstat: async () => { throw new Error("boom"); } }); r = await broken.handle(saveReq("a.txt", "x", 1), new URL("http://x/api/files/save")); expect(r.status).toBe(500); expect(await r.text()).toBe("files failed"); expect(new Uint8Array(await Bun.file(join(root, "a.txt")).arrayBuffer())).toEqual(originalBytes);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
    test("refuses symlinks", async () => { if (!CAN_SYMLINK) return; const root = await mkdtemp(join(tmpdir(), "sightr-save-link-")); const outside = await mkdtemp(join(tmpdir(), "sightr-save-link-out-")); try { await writeFile(join(root, "a.txt"), "hello"); await writeFile(join(outside, "secret.txt"), "outside-secret"); await symlink(join(root, "a.txt"), join(root, "inside")); await symlink(join(outside, "secret.txt"), join(root, "outside")); const w = createWorkdir(cfg(root), helpers); expect((await w.handle(saveReq("inside", "x", 1), new URL("http://x/api/files/save"))).status).toBe(404); expect((await w.handle(saveReq("outside", "x", 1), new URL("http://x/api/files/save"))).status).toBe(404); expect(await Bun.file(join(root, "a.txt")).text()).toBe("hello"); expect(await Bun.file(join(outside, "secret.txt")).text()).toBe("outside-secret"); } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); } });
  });

  test("calls the read gate", async () => {
    const gated = createWorkdir(cfg("/tmp"), { ...helpers, guard: () => new Response("forbidden", { status: 403 }) });
    expect((await gated.handle(new Request("http://x/api/files"), new URL("http://x/api/files"))).status).toBe(403);
    expect((await gated.handle(new Request("http://x/api/files/git?path="), new URL("http://x/api/files/git?path="))).status).toBe(403);
  });

  test("routes folder git by path and filters panes to the repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-git-route-"));
    try {
      const w = createWorkdir(cfg(root), helpers);
      const response = await w.handle(new Request("http://x/api/files/git?path="), new URL("http://x/api/files/git?path="));
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ available: false, reason: "not-a-repo" }); expect(response.headers.get("cache-control")).toBe("no-store");
      for (const path of ["../escape", "/abs", ".env", "missing"]) expect((await w.handle(new Request(`http://x/api/files/git?path=${encodeURIComponent(path)}`), new URL(`http://x/api/files/git?path=${encodeURIComponent(path)}`))).status).toBe(404);
      await mkdir(join(root, "repo"), { recursive: true }); const init = Bun.spawn(["git", "init", "-q"], { cwd: join(root, "repo"), stdout: "ignore", stderr: "ignore" }); await init.exited; await writeFile(join(root, "file"), "x");
      const routed = createWorkdir(cfg(root), { ...helpers, paneCwd: (id: string) => id === "p1" ? join(root, "repo") : null });
      const routedResponse = await routed.handle(new Request("http://x/api/files/git?path=repo&pane=p1&pane=ghost"), new URL("http://x/api/files/git?path=repo&pane=p1&pane=ghost"));
      expect((await routedResponse.json()).panes).toEqual(["p1"]); expect((await w.handle(new Request("http://x/api/files/git?path=file"), new URL("http://x/api/files/git?path=file"))).status).toBe(404);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("is inert without a root", () => {
    const w = createWorkdir(cfg(""), helpers); expect(w.enabled).toBe(false); expect(w.owns("/api/files")).toBe(false); expect(w.owns("/api/files/search")).toBe(false);
  });

  test("opens allowlisted types inline including JS", async () => {
    expect(browserOpenType("shot.PNG")).toBe("image/png");
    expect(browserOpenType("notes.md")).toBe("text/plain; charset=utf-8");
    expect(browserOpenType("page.html")).toBe("text/html; charset=utf-8");
    expect(browserOpenType("index.HTM")).toBe("text/html; charset=utf-8");
    expect(browserOpenType("icon.svg")).toBe("image/svg+xml");
    expect(browserOpenType("app.js")).toBe("text/javascript; charset=utf-8");
    expect(browserOpenType("app.mjs")).toBe("text/javascript; charset=utf-8");
    expect(browserOpenCsp("text/html; charset=utf-8")).toBe(BROWSER_HTML_CSP);
    expect(browserOpenCsp("image/svg+xml")).toBe(BROWSER_HTML_CSP);
    expect(BROWSER_HTML_CSP).toContain("sandbox");
    expect(BROWSER_HTML_CSP).toContain("allow-scripts");
    expect(BROWSER_HTML_CSP).not.toContain("allow-same-origin");
    expect(BROWSER_HTML_CSP).not.toContain("script-src");
    expect(browserOpenCsp("image/png")).toBeUndefined();
    expect(browserOpenCsp("text/javascript; charset=utf-8")).toBeUndefined();
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-open-"));
    try {
      await writeFile(join(root, "shot.png"), "png-bytes");
      await writeFile(join(root, "page.html"), "<script>alert(1)</script>");
      await writeFile(join(root, "notes.txt"), "hello");
      const w = createWorkdir(cfg(root), helpers);
      const png = await w.handle(new Request("http://x/api/files/open?path=shot.png"), new URL("http://x/api/files/open?path=shot.png"));
      expect(png.status).toBe(200);
      expect(png.headers.get("content-disposition")).toContain("inline");
      expect(png.headers.get("content-type")).toBe("image/png");
      expect(png.headers.get("x-content-type-options")).toBe("nosniff");
      expect(png.headers.get("content-security-policy")).toBeNull();
      const listed = await (await w.handle(new Request("http://x/api/files?path=shot.png"), new URL("http://x/api/files?path=shot.png"))).json();
      expect(listed.openInBrowser).toBe(true);
      expect(listed.embed).toBe("image");
      const html = await w.handle(new Request("http://x/api/files/open?path=page.html"), new URL("http://x/api/files/open?path=page.html"));
      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(html.headers.get("content-disposition")).toContain("inline");
      expect(html.headers.get("content-security-policy")).toBe(BROWSER_HTML_CSP);
      expect(await html.text()).toContain("alert(1)");
      const htmlMeta = await (await w.handle(new Request("http://x/api/files?path=page.html"), new URL("http://x/api/files?path=page.html"))).json();
      expect(htmlMeta.openInBrowser).toBe(true);
      expect(htmlMeta.embed).toBeUndefined();
      expect(htmlMeta.binary).toBe(false);
      const txt = await w.handle(new Request("http://x/api/files/open?path=notes.txt"), new URL("http://x/api/files/open?path=notes.txt"));
      expect(txt.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const dl = await w.handle(new Request("http://x/api/files/download?path=page.html"), new URL("http://x/api/files/download?path=page.html"));
      expect(dl.status).toBe(200);
      expect(dl.headers.get("content-disposition")).toContain("attachment");
      expect(dl.headers.get("content-security-policy")).toBeNull();
      await writeFile(join(root, "clip.mp4"), "mp4");
      await writeFile(join(root, "track.mp3"), "mp3");
      await writeFile(join(root, "doc.pdf"), "%PDF");
      await writeFile(join(root, "icon.svg"), "<svg></svg>");
      expect(browserEmbedKind("shot.png")).toBe("image");
      expect(browserEmbedKind("clip.mp4")).toBe("video");
      expect(browserEmbedKind("track.mp3")).toBe("audio");
      expect(browserEmbedKind("doc.pdf")).toBeUndefined();
      expect(browserEmbedKind("notes.txt")).toBeUndefined();
      expect(browserEmbedKind("page.html")).toBeUndefined();
      expect(browserEmbedKind("icon.svg")).toBe("image");
      const mp4 = await (await w.handle(new Request("http://x/api/files?path=clip.mp4"), new URL("http://x/api/files?path=clip.mp4"))).json();
      expect(mp4.embed).toBe("video");
      const mp3 = await (await w.handle(new Request("http://x/api/files?path=track.mp3"), new URL("http://x/api/files?path=track.mp3"))).json();
      expect(mp3.embed).toBe("audio");
      const pdf = await (await w.handle(new Request("http://x/api/files?path=doc.pdf"), new URL("http://x/api/files?path=doc.pdf"))).json();
      expect(pdf.openInBrowser).toBe(true);
      expect(pdf.embed).toBeUndefined();
      const svg = await w.handle(new Request("http://x/api/files/open?path=icon.svg"), new URL("http://x/api/files/open?path=icon.svg"));
      expect(svg.status).toBe(200);
      expect(svg.headers.get("content-type")).toBe("image/svg+xml");
      expect(svg.headers.get("content-security-policy")).toBe(BROWSER_HTML_CSP);
      await writeFile(join(root, "app.js"), "alert(1)");
      const js = await w.handle(new Request("http://x/api/files/open?path=app.js"), new URL("http://x/api/files/open?path=app.js"));
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(js.headers.get("content-security-policy")).toBeNull();
      expect(browserEmbedKind("app.js")).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("path-style open is a folder so HTML siblings resolve", async () => {
    expect(isFilesOpenPath("/api/files/open")).toBe(true);
    expect(isFilesOpenPath("/api/files/open/site/index.html")).toBe(true);
    expect(isFilesOpenPath("/api/files/openfoo")).toBe(false);
    expect(parseFilesOpenRel(new URL("http://x/api/files/open/site/hero.png"))).toEqual(["site", "hero.png"]);
    expect(parseFilesOpenRel(new URL("http://x/api/files/open?path=site/hero.png"))).toEqual(["site", "hero.png"]);
    expect(parseFilesOpenRel(new URL("http://x/api/files/open/site/my%20photo.png"))).toEqual(["site", "my photo.png"]);
    expect(parseFilesOpenRel(new URL("http://x/api/files/open/"))).toBeNull();
    expect(parseFilesOpenRel(new URL("http://x/api/files/open/%2e%2e/secret"))).toBeNull();
    expect(parseFilesOpenRel(new URL("http://x/api/files/open/%ZZ"))).toBeNull();
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-open-path-"));
    try {
      await mkdir(join(root, "site"));
      await writeFile(join(root, "site", "index.html"), '<img src="hero.png">');
      await writeFile(join(root, "site", "hero.png"), "png-bytes");
      await writeFile(join(root, "site", "my photo.png"), "spaced");
      await writeFile(join(root, "site", "icon.svg"), "<svg></svg>");
      const w = createWorkdir(cfg(root), helpers);
      const call = (path: string) => w.handle(new Request(`http://x${path}`), new URL(`http://x${path}`));
      const html = await call("/api/files/open/site/index.html");
      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(html.headers.get("content-security-policy")).toBe(BROWSER_HTML_CSP);
      const img = await call("/api/files/open/site/hero.png");
      expect(img.status).toBe(200);
      expect(img.headers.get("content-type")).toBe("image/png");
      expect(await img.text()).toBe("png-bytes");
      expect((await call("/api/files/open?path=site/hero.png")).status).toBe(200);
      expect((await call("/api/files/open/site/my%20photo.png")).status).toBe(200);
      const siblingSvg = await call("/api/files/open/site/icon.svg");
      expect(siblingSvg.status).toBe(200);
      expect(siblingSvg.headers.get("content-type")).toBe("image/svg+xml");
      expect(siblingSvg.headers.get("content-security-policy")).toBe(BROWSER_HTML_CSP);
      await writeFile(join(root, "site", "app.js"), "window.VARIANTS={}");
      const siblingJs = await call("/api/files/open/site/app.js");
      expect(siblingJs.status).toBe(200);
      expect(siblingJs.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(siblingJs.headers.get("content-security-policy")).toBeNull();
      expect((await call("/api/files/open/")).status).toBe(404);
      expect((await call("/api/files/open/site/../hero.png")).status).toBe(404);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("repo flag", () => {
  test("a folder holding .git (dir or worktree file) is flagged, .git itself stays hidden", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-workdir-repo-"));
    try {
      await mkdir(join(root, "checkout", ".git"), { recursive: true }); await mkdir(join(root, "worktree")); await writeFile(join(root, "worktree", ".git"), "gitdir: elsewhere"); await mkdir(join(root, "plain"));
      const w = createWorkdir(cfg(root), helpers);
      const listing = JSON.parse(await (await w.handle(new Request("http://x/api/files"), new URL("http://x/api/files"))).text());
      expect(listing.entries.map((e: { name: string; repo?: boolean }) => [e.name, e.repo ?? false])).toEqual([["checkout", true], ["plain", false], ["worktree", true]]);
      const inside = JSON.parse(await (await w.handle(new Request("http://x/api/files?path=checkout"), new URL("http://x/api/files?path=checkout"))).text());
      expect(inside.entries).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
