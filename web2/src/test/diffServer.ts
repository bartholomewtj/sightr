// A fake of T26's review API for tests (msw): the file list with an ETag and a 304, one patch at a time with
// delays, truncated, binary and failing files, and the branch list. It counts what the client asks for, and
// how many patch requests are in flight at once, so a test can pin the panel's concurrency cap. No network.
import { REVIEW_PATHS, type ReviewBranch, type ReviewFileKind, type ReviewFileStat, type ReviewSide } from "@shared/v2/review";
import { http, HttpResponse, type HttpHandler } from "msw";

export interface FakeFile {
  path: string;
  oldPath?: string;
  kind?: ReviewFileKind;
  added?: number;
  removed?: number;
  binary?: true;
  tooLarge?: true;
  /** The patch the bridge sends. Default: a one-hunk change of `path`. */
  patch?: string;
  /** The bridge cut the patch (it answers `truncated: true`). */
  truncated?: boolean;
  /** Answer `available: false` with this reason instead of a patch. */
  unavailable?: string;
  /** Fail the request (HTTP 500) this many times, then succeed. */
  failTimes?: number;
  /** Bump to change the file's `rev` (its patch should be fetched again). */
  version?: number;
  /** T28: the patch the bridge sends for `ignoreWhitespace=1` (default: `patch`). */
  wsPatch?: string;
  /** T28: with `ignoreWhitespace=1` the file has no change left. Like git, the list then leaves it out (`wsListed` keeps it, flagged `whitespaceOnly` with 0/0). */
  whitespaceOnly?: true;
  wsListed?: true;
  /** T28: the whole-file contents route; default: a text file of `new` lines. Either side may be any state. */
  contents?: { old?: ReviewSide; new: ReviewSide };
  /** T28: the contents route answers this HTTP status instead (404 is what a hidden name gets). */
  contentsStatus?: number;
}

/** A small unified diff of one file: `old` replaced by `new`, with a line of context each side. */
export function fakePatch(path: string, oldText = "old", newText = "new"): string {
  return [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1,3 +1,3 @@", " before", `-${oldText}`, `+${newText}`, " after", ""].join("\n");
}

export const SHA_FROM = "a".repeat(40);
export const SHA_TO = "b".repeat(40);

export interface DiffServer {
  handlers: HttpHandler[];
  files: FakeFile[];
  branches: ReviewBranch[];
  defaultBase: string | undefined;
  /** The branch list says it was cut at the newest refs. */
  branchesTruncated: boolean;
  /** Ref names the list accepts as `base`; any other answers `bad-base`. */
  knownBases: Set<string>;
  listCalls: URL[];
  listHeaders: Array<{ ifNoneMatch: string | null }>;
  patchCalls: URL[];
  /** T28: the whole-file contents requests. */
  contentsCalls: URL[];
  branchCalls: URL[];
  /** Patch requests being answered right now, and the most there ever were. */
  inflight: number;
  maxInflight: number;
  /** Hold every patch response until `release()` (a test that needs requests to overlap). */
  hold: boolean;
  /** Milliseconds every patch response takes. */
  patchDelayMs: number;
  /** A list request answers `available: false` with this reason. */
  listUnavailable: string | null;
  /** Only the plain list (no `ignoreWhitespace`) answers `available: false` with this reason (T28). */
  plainListUnavailable: string | null;
  /** Change the list: new `diffHash`, so a refresh sees a change. */
  setFiles(files: FakeFile[]): void;
  /** Let the held patch responses go. */
  release(): void;
  /** The paths asked for, in order. */
  patchPaths(): string[];
}

const rev = (f: FakeFile, ws = false) => `${f.path}:${f.version ?? 0}:${f.kind ?? "modified"}${ws ? ":w" : ""}`;

export function createDiffServer(initial: FakeFile[] = []): DiffServer {
  let hash = 1;
  let waiters: Array<() => void> = [];
  const failed = new Map<string, number>();
  const server: DiffServer = {
    handlers: [],
    files: initial,
    branches: [
      { name: "main", remote: false, current: true, time: 1_700_000_000 },
      { name: "origin/main", remote: true, time: 1_699_990_000 },
      { name: "develop", remote: false, time: 1_699_000_000 },
    ],
    defaultBase: "origin/main",
    branchesTruncated: false,
    knownBases: new Set(["main", "origin/main", "develop"]),
    listCalls: [],
    listHeaders: [],
    patchCalls: [],
    contentsCalls: [],
    branchCalls: [],
    inflight: 0,
    maxInflight: 0,
    hold: false,
    patchDelayMs: 0,
    listUnavailable: null,
    plainListUnavailable: null,
    setFiles(files) {
      server.files = files;
      hash += 1;
    },
    release() {
      server.hold = false;
      const go = waiters;
      waiters = [];
      for (const w of go) w();
    },
    patchPaths: () => server.patchCalls.map((u) => u.searchParams.get("file") ?? ""),
  };

  const stat = (f: FakeFile, ws = false): ReviewFileStat => {
    const wsOnly = ws && f.whitespaceOnly === true;
    return {
      path: f.path,
      ...(f.oldPath === undefined ? {} : { oldPath: f.oldPath }),
      kind: f.kind ?? "modified",
      added: wsOnly ? 0 : (f.added ?? (f.binary ? 0 : 1)),
      removed: wsOnly ? 0 : (f.removed ?? (f.binary ? 0 : 1)),
      ...(f.binary ? { binary: true as const } : {}),
      ...(f.tooLarge ? { tooLarge: true as const } : {}),
      ...(wsOnly ? { whitespaceOnly: true as const } : {}),
      rev: rev(f, ws),
    };
  };

  const listed = (ws: boolean) => server.files.filter((f) => !(ws && f.whitespaceOnly && !f.wsListed)).map((f) => stat(f, ws));

  server.handlers = [
    http.get(REVIEW_PATHS.list, ({ request }) => {
      const url = new URL(request.url);
      server.listCalls.push(url);
      const ifNoneMatch = request.headers.get("if-none-match");
      server.listHeaders.push({ ifNoneMatch });
      if (server.listUnavailable) return HttpResponse.json({ available: false, reason: server.listUnavailable });
      if (server.plainListUnavailable && url.searchParams.get("ignoreWhitespace") !== "1") return HttpResponse.json({ available: false, reason: server.plainListUnavailable });
      const scope = url.searchParams.get("scope");
      const base = url.searchParams.get("base");
      if (scope === "branch" && base !== null && !server.knownBases.has(base)) return HttpResponse.json({ available: false, reason: "bad-base" });
      const ws = url.searchParams.get("ignoreWhitespace") === "1";
      const diffHash = `h${hash}${scope === "branch" ? `-${base ?? "default"}` : ""}${ws ? "-w" : ""}`;
      if (ifNoneMatch === `"${diffHash}"`) return new HttpResponse(null, { status: 304, headers: { etag: `"${diffHash}"` } });
      const body =
        scope === "branch"
          ? { available: true, scope: "branch", base: base ?? server.defaultBase ?? "main", ...(base === null ? { baseIsDefault: true } : {}), from: SHA_FROM, to: SHA_TO, files: listed(ws), hidden: 0, truncated: false, diffHash }
          : { available: true, scope: "working-tree", files: listed(ws), hidden: 0, truncated: false, diffHash };
      return HttpResponse.json(body, { headers: { etag: `"${diffHash}"` } });
    }),
    http.get(REVIEW_PATHS.patch, async ({ request }) => {
      const url = new URL(request.url);
      server.patchCalls.push(url);
      server.inflight += 1;
      server.maxInflight = Math.max(server.maxInflight, server.inflight);
      try {
        if (server.hold) await new Promise<void>((resolve) => waiters.push(resolve));
        if (server.patchDelayMs > 0) await new Promise((r) => setTimeout(r, server.patchDelayMs));
        const path = url.searchParams.get("file") ?? "";
        const file = server.files.find((f) => f.path === path);
        if (!file) return HttpResponse.json({ available: false, reason: "bad-file" });
        if (file.failTimes) {
          const seen = failed.get(path) ?? 0;
          if (seen < file.failTimes) {
            failed.set(path, seen + 1);
            return new HttpResponse("boom", { status: 500 });
          }
        }
        if (file.unavailable) return HttpResponse.json({ available: false, reason: file.unavailable });
        const ws = url.searchParams.get("ignoreWhitespace") === "1";
        const patch = (ws ? (file.wsPatch ?? (file.whitespaceOnly ? "" : file.patch)) : file.patch) ?? fakePatch(file.path, `old ${file.version ?? 0}`, `new ${file.version ?? 0}`);
        return HttpResponse.json({ available: true, patch, truncated: file.truncated === true, diffHash: `p-${rev(file, ws)}` });
      } finally {
        server.inflight -= 1;
      }
    }),
    http.get(REVIEW_PATHS.contents, ({ request }) => {
      const url = new URL(request.url);
      server.contentsCalls.push(url);
      const file = server.files.find((f) => f.path === url.searchParams.get("file"));
      if (!file) return new HttpResponse("not found", { status: 404 });
      if (file.contentsStatus) return new HttpResponse("no", { status: file.contentsStatus });
      const side: ReviewSide = file.contents?.new ?? { state: "text", text: "line\n", crlf: false };
      return HttpResponse.json({ available: true, old: file.contents?.old ?? { state: "absent" }, new: side, diffHash: `c-${rev(file)}` });
    }),
    http.get(REVIEW_PATHS.branches, ({ request }) => {
      server.branchCalls.push(new URL(request.url));
      return HttpResponse.json({ available: true, current: "main", ...(server.defaultBase ? { defaultBase: server.defaultBase } : {}), branches: server.branches, truncated: server.branchesTruncated });
    }),
  ];
  return server;
}
