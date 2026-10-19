// Pattern from T3 Code apps/web/src/lib/diffFileContents.ts @ 3a4d118a518a (MIT, see THIRD_PARTY.md): the
// same job, a loader that fetches a changed file's whole old and new text once so "expand unchanged
// lines" can fill the gaps between hunks, and keeps it by a cache key. T3 builds a Pierre
// `FileDiffContentsLoader` over Effect atoms and RPC; Sightr has no Pierre or Effect, so this is a small
// cache over T26's contents route (`lib/diffApi.ts`) that hands the seam (`onExpandContext`) its text.
// The route is asked for once per (folder, scope, diffHash, path) however many controls are tapped, and
// only when a control is tapped, never on render. A new `diffHash` is a different key, so a refreshed list
// reads the file again. A failure is not cached (a retry asks again); a binary, too-large or refused file is.
import type { ReviewSide } from "@shared/v2/review";

import { ApiError } from "./api";
import { fetchDiffFileContents, type DiffRequestScope } from "./diffApi";

/** What the seam's `onExpandContext` resolves to (the hand adapter reads `newText`; `oldText` is the other side, for adapters that want both). */
export type DiffExpandContents =
  | { oldText: string; newText: string }
  /** The file cannot be expanded: not text (`binary`), over the host's size cap, a name the host does not show, or gone from disk. */
  | { unavailable: "binary" | "too-large" | "refused" | "absent" };

export interface DiffContentsTarget {
  folder: string;
  /** The scope as the list was asked (no `ignoreWhitespace`: the contents are the files as they are). */
  scope: DiffRequestScope;
  /** The list's `diffHash` (T26), so a refresh that changed the diff reads the file again. */
  diffHash: string;
  file: { path: string; oldPath?: string };
  range: { from?: string; to?: string };
}

const sideText = (side: ReviewSide): string => (side.state === "text" ? side.text : "");

function toExpand(old: ReviewSide, now: ReviewSide): DiffExpandContents {
  switch (now.state) {
    case "text":
      return { oldText: sideText(old), newText: now.text };
    case "binary":
      return { unavailable: "binary" };
    case "too-large":
      return { unavailable: "too-large" };
    case "absent":
      return { unavailable: "absent" };
  }
}

export class DiffContentsCache {
  private readonly entries = new Map<string, Promise<DiffExpandContents | null>>();
  private readonly controllers = new Set<AbortController>();
  /** How many requests went to the host (a test reads this). */
  requests = 0;

  /** The file's text, or null when the read failed (the caller shows "Couldn't read this file" and may try again). */
  load(target: DiffContentsTarget): Promise<DiffExpandContents | null> {
    const { scope: s } = target;
    const detail = s.kind === "branch" ? (s.base ?? "") : s.kind === "run" ? `${s.threadId}\0${s.runId}` : "";
    const key = [target.folder, s.kind, detail, target.diffHash, target.file.path].join("\0");
    const live = this.entries.get(key);
    if (live) return live;
    const controller = new AbortController();
    this.controllers.add(controller);
    this.requests += 1;
    const { ignoreWhitespace: _ignored, ...scope } = target.scope;
    void _ignored;
    const pending = fetchDiffFileContents(target.folder, scope as DiffRequestScope, target.file, target.range, controller.signal).then(
      (res): DiffExpandContents | null => (res.available ? toExpand(res.old, res.new) : null),
      (err: unknown): DiffExpandContents | null => (err instanceof ApiError && err.status === 404 ? { unavailable: "refused" } : null),
    );
    const settled = pending.then((r) => {
      this.controllers.delete(controller);
      if (r === null) this.entries.delete(key); // not cached: the next tap asks again
      return r;
    });
    this.entries.set(key, settled);
    return settled;
  }

  /** The panel unmounted: abort what is in flight and forget everything. */
  dispose(): void {
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    this.entries.clear();
  }
}
