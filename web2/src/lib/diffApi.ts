// The diff panel's reads (T27): T26's review routes (`REVIEW_PATHS`, shapes in shared/v2/review.ts) by plain
// fetch. T3 reads the same data through Effect atoms and RPC (`state/review.ts`); neither is taken. Every call
// takes the thread's Files folder (`usePaneFolder`, a Files rel path: the client never sees an absolute path)
// and an AbortSignal, because the panel cancels what it no longer needs (a scope change, an unmount).
import {
  REVIEW_PATHS,
  type ReviewBranches,
  type ReviewDiffFileContents,
  type ReviewDiffFilePatch,
  type ReviewDiffPreview,
  type ReviewFileStat,
} from "@shared/v2/review";

import { ApiError, noteIfLocked, XHR_HEADER, XHR_HEADER_VALUE } from "./api";

/**
 * The scope a request names. A run (T30/T31) names a thread and a run instead of a folder: the bridge finds the repo
 * from the run's checkpoint. Its file list is `Run.checkpoint.files` on the thread stream, so only its patch and contents are fetched.
 */
export type DiffRequestScope = ({ kind: "working-tree" } | { kind: "branch"; base?: string } | { kind: "run"; threadId: string; runId: string }) & {
  /** Ask the host for `git diff -w` (T28). The list and the patches take it; the contents route does not. */
  ignoreWhitespace?: boolean;
};

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
  if (scope?.kind === "run") {
    // No `path`: the checkpoint row names the repo. `w` is the run route's ignore-whitespace flag.
    q.set("scope", "run");
    q.set("threadId", scope.threadId);
    q.set("runId", scope.runId);
    q.set("w", scope.ignoreWhitespace ? "1" : "0");
    return q;
  }
  q.set("path", folderPath);
  if (scope) {
    q.set("scope", scope.kind);
    if (scope.kind === "branch" && scope.base) q.set("base", scope.base);
    if (scope.ignoreWhitespace) q.set("ignoreWhitespace", "1");
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

/**
 * One file's whole old and new text, for "expand unchanged lines" (T28). The branch scope names the same
 * commit range as the patch. Never called before the operator taps a control; the cache is `lib/diffFileContents.ts`.
 */
export async function fetchDiffFileContents(
  folderPath: string,
  scope: DiffRequestScope,
  file: Pick<ReviewFileStat, "path" | "oldPath">,
  range: { from?: string; to?: string },
  signal?: AbortSignal,
): Promise<ReviewDiffFileContents> {
  const q = query(folderPath, scope);
  q.delete("ignoreWhitespace"); // the contents are the files as they are
  q.delete("w");
  q.set("file", file.path);
  if (file.oldPath !== undefined) q.set("oldFile", file.oldPath);
  if (scope.kind === "branch") {
    q.set("from", range.from ?? "");
    q.set("to", range.to ?? "");
  }
  return (await (await getJson(`${REVIEW_PATHS.contents}?${q}`, signal)).json()) as ReviewDiffFileContents;
}

/**
 * One file of a run's diff (T30's `scope=run` route, filling T26's stub): the patch the bridge stored when the run ended
 * (`ignoreWhitespace` false), or computed from the run's snapshots (true, which needs them to be live). No folder: the
 * route finds the repo from the run's checkpoint, so an archived thread works. `file` is the checkpoint's repo path.
 */
export async function fetchRunDiff(
  runId: string,
  opts: { threadId: string; file: string; ignoreWhitespace?: boolean },
  signal?: AbortSignal,
): Promise<ReviewDiffFilePatch> {
  const q = query("", { kind: "run", threadId: opts.threadId, runId, ...(opts.ignoreWhitespace ? { ignoreWhitespace: true } : {}) });
  q.set("file", opts.file);
  return (await (await getJson(`${REVIEW_PATHS.patch}?${q}`, signal)).json()) as ReviewDiffFilePatch;
}

/** The branches for the base picker. */
export async function fetchDiffBranches(folderPath: string, signal?: AbortSignal): Promise<ReviewBranches> {
  return (await (await getJson(`${REVIEW_PATHS.branches}?${query(folderPath, null)}`, signal)).json()) as ReviewBranches;
}
