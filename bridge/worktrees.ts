// Herdr worktree grouping for the Spaces tree. Snapshot `workspace.worktree` is the provenance
// Herdr already knows; `worktree.list` fills in branch + closed sibling checkouts so the phone
// tree can pack a repo the same way Herdr's sidebar does (parent + indented linked children).
//
// Listing is per git root, cached, and skipped entirely when a cheap `.git` walk says the cwd
// is not a checkout — so the 40-space non-git herd does not pay 40 RPCs a poll.
import { dirname, join, resolve } from "node:path";
import { access } from "node:fs/promises";
import type { ClosedWorktree, WorkspaceView, WorkspaceWorktree } from "../shared/wire.ts";
import type { WireWorktree, WireWorktreeSource, WorktreeList } from "./herdr-client.ts";
import { herdrErrorCode } from "./herdr-client.ts";

export const WORKTREE_TTL_MS = 8_000;
export const GIT_WALK_MAX = 16;

export interface PaneCwd {
  workspaceId: string;
  cwd: string;
}

type CacheHit = { at: number; miss: true } | { at: number; source: WireWorktreeSource; worktrees: WireWorktree[] };

export interface WorktreeLister {
  listWorktrees(opts: { cwd?: string; workspaceId?: string }): Promise<WorktreeList>;
}

export function normPath(p: string): string {
  let s = p.replace(/^\\\\\?\\/, "").replace(/\\/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  if (process.platform === "win32") s = s.toLowerCase();
  return s;
}

export function pathContains(parent: string, child: string): boolean {
  const p = normPath(parent);
  const c = normPath(child);
  return c === p || c.startsWith(`${p}/`);
}

export async function findGitRoot(
  cwd: string,
  exists: (path: string) => Promise<boolean> = pathExists,
): Promise<string | null> {
  let dir = resolve(cwd);
  for (let i = 0; i <= GIT_WALK_MAX; i++) {
    if (await exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

function matchWorktree(cwd: string | undefined, workspaceId: string, worktrees: WireWorktree[]): WireWorktree | undefined {
  const byId = worktrees.find((t) => t.open_workspace_id === workspaceId);
  if (byId) return byId;
  if (!cwd) return undefined;
  let best: WireWorktree | undefined;
  let bestLen = -1;
  for (const t of worktrees) {
    if (!pathContains(t.path, cwd)) continue;
    const n = normPath(t.path).length;
    if (n > bestLen) {
      best = t;
      bestLen = n;
    }
  }
  return best;
}

function toViewWorktree(source: WireWorktreeSource, wt: WireWorktree): WorkspaceWorktree {
  return {
    repoKey: source.repo_key,
    repoName: source.repo_name,
    repoRoot: source.repo_root,
    checkoutPath: wt.path,
    isLinkedWorktree: wt.is_linked_worktree,
    branch: wt.branch,
  };
}

function closedOf(worktrees: WireWorktree[]): ClosedWorktree[] {
  return worktrees
    .filter((t) => t.is_linked_worktree && !t.open_workspace_id)
    .map((t) => ({
      path: t.path,
      label: t.label,
      branch: t.branch,
      isDetached: t.is_detached,
    }));
}

export function createWorktreeIndex(
  herdr: WorktreeLister,
  opts: {
    now?: () => number;
    exists?: (path: string) => Promise<boolean>;
    ttlMs?: number;
  } = {},
) {
  const now = opts.now ?? Date.now;
  const exists = opts.exists ?? pathExists;
  const ttlMs = opts.ttlMs ?? WORKTREE_TTL_MS;
  const cache = new Map<string, CacheHit>();
  const inflight = new Map<string, Promise<void>>();

  function invalidate(): void {
    cache.clear();
  }

  function fresh(entry: CacheHit | undefined): boolean {
    return !!entry && now() - entry.at < ttlMs;
  }

  async function loadRoot(gitRoot: string): Promise<void> {
    const pending = inflight.get(gitRoot);
    if (pending) return pending;
    const run = (async () => {
      try {
        const listed = await herdr.listWorktrees({ cwd: gitRoot });
        cache.set(gitRoot, { at: now(), source: listed.source, worktrees: listed.worktrees });
      } catch (err) {
        const code = herdrErrorCode(err);
        if (code === "not_git_worktree" || code === "invalid_request") {
          cache.set(gitRoot, { at: now(), miss: true });
          return;
        }
        cache.set(gitRoot, { at: now(), miss: true });
      } finally {
        inflight.delete(gitRoot);
      }
    })();
    inflight.set(gitRoot, run);
    return run;
  }

  async function decorate(workspaces: WorkspaceView[], panes: readonly PaneCwd[]): Promise<WorkspaceView[]> {
    const cwdByWs = new Map<string, string>();
    for (const p of panes) {
      if (!cwdByWs.has(p.workspaceId) && p.cwd) cwdByWs.set(p.workspaceId, p.cwd);
    }

    const roots = new Map<string, string>(); // gitRoot → first cwd
    for (const w of workspaces) {
      const cwd = cwdByWs.get(w.workspaceId);
      if (!cwd) continue;
      const root = await findGitRoot(cwd, exists);
      if (!root) continue;
      if (!roots.has(root)) roots.set(root, cwd);
    }

    const loads: Promise<void>[] = [];
    for (const root of roots.keys()) {
      if (!fresh(cache.get(root))) loads.push(loadRoot(root));
    }
    if (loads.length) await Promise.all(loads);

    const lists: Array<{ source: WireWorktreeSource; worktrees: WireWorktree[] }> = [];
    for (const root of roots.keys()) {
      const hit = cache.get(root);
      if (hit && !("miss" in hit)) lists.push(hit);
    }

    if (lists.length === 0) return workspaces;

    return workspaces.map((w) => {
      const cwd = cwdByWs.get(w.workspaceId);
      let stamped: WorkspaceWorktree | undefined = w.worktree;
      let closed: ClosedWorktree[] | undefined;
      for (const list of lists) {
        const match = matchWorktree(cwd, w.workspaceId, list.worktrees);
        if (!match) continue;
        stamped = toViewWorktree(list.source, match);
        closed = closedOf(list.worktrees);
        break;
      }
      if (!stamped && !closed?.length) return w;
      return {
        ...w,
        ...(stamped ? { worktree: stamped } : {}),
        ...(closed?.length ? { closedWorktrees: closed } : {}),
      };
    });
  }

  return { decorate, invalidate };
}

export type WorktreeIndex = ReturnType<typeof createWorktreeIndex>;
