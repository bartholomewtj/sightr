// A fake of T26's review API for tests (msw): the file list with an ETag and a 304, one patch at a time with
// delays, truncated, binary and failing files, and the branch list. It counts what the client asks for, and
// how many patch requests are in flight at once, so a test can pin the panel's concurrency cap. No network.
import { REVIEW_PATHS, type ReviewBranch, type ReviewFileKind, type ReviewFileStat } from "@shared/v2/review";
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
  /** Change the list: new `diffHash`, so a refresh sees a change. */
  setFiles(files: FakeFile[]): void;
  /** Let the held patch responses go. */
  release(): void;
  /** The paths asked for, in order. */
  patchPaths(): string[];
}

const rev = (f: FakeFile) => `${f.path}:${f.version ?? 0}:${f.kind ?? "modified"}`;

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
    branchCalls: [],
    inflight: 0,
    maxInflight: 0,
    hold: false,
    patchDelayMs: 0,
    listUnavailable: null,
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

  const stat = (f: FakeFile): ReviewFileStat => ({
    path: f.path,
    ...(f.oldPath === undefined ? {} : { oldPath: f.oldPath }),
    kind: f.kind ?? "modified",
    added: f.added ?? (f.binary ? 0 : 1),
    removed: f.removed ?? (f.binary ? 0 : 1),
    ...(f.binary ? { binary: true as const } : {}),
    ...(f.tooLarge ? { tooLarge: true as const } : {}),
    rev: rev(f),
  });

  server.handlers = [
    http.get(REVIEW_PATHS.list, ({ request }) => {
      const url = new URL(request.url);
      server.listCalls.push(url);
      const ifNoneMatch = request.headers.get("if-none-match");
      server.listHeaders.push({ ifNoneMatch });
      if (server.listUnavailable) return HttpResponse.json({ available: false, reason: server.listUnavailable });
      const scope = url.searchParams.get("scope");
      const base = url.searchParams.get("base");
      if (scope === "branch" && base !== null && !server.knownBases.has(base)) return HttpResponse.json({ available: false, reason: "bad-base" });
      const diffHash = `h${hash}${scope === "branch" ? `-${base ?? "default"}` : ""}`;
      if (ifNoneMatch === `"${diffHash}"`) return new HttpResponse(null, { status: 304, headers: { etag: `"${diffHash}"` } });
      const body =
        scope === "branch"
          ? { available: true, scope: "branch", base: base ?? server.defaultBase ?? "main", ...(base === null ? { baseIsDefault: true } : {}), from: SHA_FROM, to: SHA_TO, files: server.files.map(stat), hidden: 0, truncated: false, diffHash }
          : { available: true, scope: "working-tree", files: server.files.map(stat), hidden: 0, truncated: false, diffHash };
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
        return HttpResponse.json({ available: true, patch: file.patch ?? fakePatch(file.path, `old ${file.version ?? 0}`, `new ${file.version ?? 0}`), truncated: file.truncated === true, diffHash: `p-${rev(file)}` });
      } finally {
        server.inflight -= 1;
      }
    }),
    http.get(REVIEW_PATHS.branches, ({ request }) => {
      server.branchCalls.push(new URL(request.url));
      return HttpResponse.json({ available: true, current: "main", ...(server.defaultBase ? { defaultBase: server.defaultBase } : {}), branches: server.branches, truncated: server.branchesTruncated });
    }),
  ];
  return server;
}
