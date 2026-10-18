// The diff panel's reads (T27): T26's review routes (`REVIEW_PATHS`, shapes in shared/v2/review.ts) by plain
// fetch. T3 reads the same data through Effect atoms and RPC (`state/review.ts`); neither is taken. Every call
// takes the thread's Files folder (`usePaneFolder`, a Files rel path: the client never sees an absolute path)
// and an AbortSignal, because the panel cancels what it no longer needs (a scope change, an unmount).
import {
  REVIEW_PATHS,
  type ReviewBranches,
  type ReviewDiffFilePatch,
  type ReviewDiffPreview,
  type ReviewFileStat,
} from "@shared/v2/review";

import { ApiError, noteIfLocked, XHR_HEADER, XHR_HEADER_VALUE } from "./api";

/** The scope a request names. A run is not fetched (it follows the thread stream). */
export type DiffRequestScope = { kind: "working-tree" } | { kind: "branch"; base?: string };

/** The server's own deadline for one review request is 25 s; leave it room to answer. */
const REVIEW_TIMEOUT_MS = 30_000;

function withTimeout(signal: AbortSignal | undefined): AbortSignal | undefined {
  if (typeof AbortSignal.timeout !== "function") return signal;
  const timeout = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

function query(folderPath: string, scope: DiffRequestScope | null): URLSearchParams {
  const q = new URLSearchParams();
  q.set("path", folderPath);
  if (scope) {
    q.set("scope", scope.kind);
    if (scope.kind === "branch" && scope.base) q.set("base", scope.base);
  }
  return q;
}

async function getJson(url: string, signal: AbortSignal | undefined, headers?: Record<string, string>): Promise<Response> {
  const res = await fetch(url, { signal: withTimeout(signal), headers: { [XHR_HEADER]: XHR_HEADER_VALUE, ...headers } });
  if (!res.ok && res.status !== 304) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* no body */
    }
    noteIfLocked(res);
    throw new ApiError(`${url.split("?")[0]} -> ${res.status} ${detail}`, res.status, detail.trim());
  }
  return res;
}

export type DiffSummaryResult = { notModified: true } | { notModified: false; preview: ReviewDiffPreview; etag: string | null };

/**
 * The file list for a scope. `ifNoneMatch` is the last `diffHash` the caller saw: the bridge answers 304
 * (an empty body) when it still matches, and nothing on screen needs to change.
 */
export async function fetchDiffSummary(
  folderPath: string,
  scope: DiffRequestScope,
  opts: { ifNoneMatch?: string | null; signal?: AbortSignal } = {},
): Promise<DiffSummaryResult> {
  const res = await getJson(
    `${REVIEW_PATHS.list}?${query(folderPath, scope)}`,
    opts.signal,
    opts.ifNoneMatch ? { "if-none-match": `"${opts.ifNoneMatch}"` } : undefined,
  );
  if (res.status === 304) return { notModified: true };
  return { notModified: false, preview: (await res.json()) as ReviewDiffPreview, etag: res.headers.get("etag") };
}

/** One file's patch. A branch scope also names the commit range the list reported (`from`, `to`). */
export async function fetchDiffFilePatch(
  folderPath: string,
  scope: DiffRequestScope,
  file: Pick<ReviewFileStat, "path" | "oldPath">,
  range: { from?: string; to?: string },
  signal?: AbortSignal,
): Promise<ReviewDiffFilePatch> {
  const q = query(folderPath, scope);
  q.set("file", file.path);
  if (file.oldPath !== undefined) q.set("oldFile", file.oldPath);
  if (scope.kind === "branch") {
    q.set("from", range.from ?? "");
    q.set("to", range.to ?? "");
  }
  return (await (await getJson(`${REVIEW_PATHS.patch}?${q}`, signal)).json()) as ReviewDiffFilePatch;
}

/** The branches for the base picker. */
export async function fetchDiffBranches(folderPath: string, signal?: AbortSignal): Promise<ReviewBranches> {
  return (await (await getJson(`${REVIEW_PATHS.branches}?${query(folderPath, null)}`, signal)).json()) as ReviewBranches;
}
