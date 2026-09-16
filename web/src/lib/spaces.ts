// Helpers for the space/tab navigator: shape the flat snapshot (agents + shell panes + tabs) into
// the per-space, per-tab tree the spaces tree renders. Worktree clustering mirrors Herdr's sidebar:
// a primary checkout is the parent row, linked checkouts indent under it, closed checkouts sit in
// the same packed group.
import { bucketOf, TRIAGE_ORDER, worstTriage, type TriageKey } from "./triage";
import type { AgentView, ClosedWorktree, TabView, WorkspaceView } from "./types";

export interface SpaceCluster {
  key: string;
  repoName?: string;
  parent: WorkspaceView | null;
  children: WorkspaceView[];
  closed: ClosedWorktree[];
}

interface TabGroup {
  tabId: string;
  label: string;
  panes: AgentView[];
}

/** Panes sharing one tab: focused first, then stable pane-id order (Herdr creation order). */
export function sortPanesInTab(panes: readonly AgentView[]): AgentView[] {
  return [...panes].sort((a, b) => {
    if (a.focused !== b.focused) return a.focused ? -1 : 1;
    return a.paneId.localeCompare(b.paneId);
  });
}

/**
 * Group a workspace's panes (agents + shells) by tab, in tab order. Panes whose tab isn't in the
 * tab list yet (a brief poll race after a create) fall into a trailing group so they're never lost.
 */
export function groupPanesByTab(
  workspaceId: string,
  tabs: TabView[],
  agents: AgentView[],
  shellPanes: AgentView[],
): TabGroup[] {
  const panes = [...agents, ...shellPanes].filter((p) => p.workspaceId === workspaceId);
  const wsTabs = tabs.filter((t) => t.workspaceId === workspaceId);

  const groups: TabGroup[] = wsTabs.map((t) => ({
    tabId: t.tabId,
    label: t.label,
    panes: sortPanesInTab(panes.filter((p) => p.tabId === t.tabId)),
  }));

  const known = new Set(wsTabs.map((t) => t.tabId));
  const orphans = panes.filter((p) => !known.has(p.tabId));
  if (orphans.length) {
    groups.push({ tabId: `${workspaceId}:other`, label: "…", panes: sortPanesInTab(orphans) });
  }

  return groups;
}

/**
 * The most urgent bucket among a set of panes — routes through {@link worstTriage}.
 * Null when the set holds no agents.
 */
export function worstBucket(panes: readonly AgentView[]): TriageKey | null {
  return worstTriage(panes);
}

/**
 * The most urgent bucket in each workspace, in ONE pass over the agents.
 *
 * Routes through {@link bucketOf}, the same classifier the herd list and the tab/space chips use —
 * this replaces a pair of helpers that ranked by STATUS_RANK instead, so a space row and its chip
 * could disagree about what a colour meant (a space holding one `working` agent and one unseen
 * `done` one showed "working" on the dashboard and "ready" on the chip). One classifier, one answer.
 *
 * A missing entry means the space holds no agent at all, which is deliberately NOT the same as
 * idle: an empty space has nothing to report, and a resting dot would claim otherwise.
 *
 * One pass rather than per-space filtering because the dashboard re-renders on every poll and used
 * to derive this per space AND again per row — spaces x agents, three times over (45 x 59 on a real
 * herd).
 */
export function spaceTriageMap(agents: readonly AgentView[]): Map<string, TriageKey> {
  const worst = new Map<string, TriageKey>();
  for (const a of agents) {
    const bucket = bucketOf(a);
    const held = worst.get(a.workspaceId);
    if (held === undefined || TRIAGE_ORDER.indexOf(bucket) < TRIAGE_ORDER.indexOf(held)) {
      worst.set(a.workspaceId, bucket);
    }
  }
  return worst;
}

/**
 * Last-used time for EVERY space in one pass over the panes. The dashboard needs this per space and
 * again per rendered row, and it re-renders on every poll; deriving it per space would be
 * spaces × panes each time (45 × 59 on a real herd, three times over). One pass, then map lookups.
 */
export function spaceLastSeenMap(panes: readonly AgentView[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const p of panes) {
    const at = p.lastSeenAt ?? 0;
    if (at > (seen.get(p.workspaceId) ?? 0)) seen.set(p.workspaceId, at);
  }
  return seen;
}

/**
 * Most-recently-used spaces first. Never-used spaces (and every space on an older bridge) tie at 0
 * and therefore keep Herdr's own workspace order behind the ones you actually touch — `sort` is
 * stable, so no timestamps means no reordering at all.
 *
 * Pass a prebuilt {@link spaceLastSeenMap} when the caller already has one.
 */


/**
 * Case-insensitive substring match on the space label. An empty/whitespace query returns the input
 * untouched, so the filter box costs nothing until you type in it.
 */
export function filterSpaces(
  workspaces: readonly WorkspaceView[],
  query: string,
): WorkspaceView[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...workspaces];
  return workspaces.filter((w) => w.label.toLowerCase().includes(q));
}

function uniqueClosed(family: readonly WorkspaceView[]): ClosedWorktree[] {
  const seen = new Set<string>();
  const out: ClosedWorktree[] = [];
  for (const w of family) {
    for (const c of w.closedWorktrees ?? []) {
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      out.push(c);
    }
  }
  return out;
}

/**
 * Pack workspaces the way Herdr's Spaces sidebar does: linked worktrees nest under the primary
 * checkout of the same repo. Unrelated spaces stay top-level, in snapshot order. A family with no
 * open primary (only linked children) still groups, with `parent` null.
 */
export function clusterSpaces(workspaces: readonly WorkspaceView[]): SpaceCluster[] {
  const used = new Set<string>();
  const byRepo = new Map<string, WorkspaceView[]>();
  for (const w of workspaces) {
    const key = w.worktree?.repoKey;
    if (!key) continue;
    const list = byRepo.get(key);
    if (list) list.push(w);
    else byRepo.set(key, [w]);
  }

  const clusters: SpaceCluster[] = [];
  for (const w of workspaces) {
    if (used.has(w.workspaceId)) continue;
    const repoKey = w.worktree?.repoKey;
    if (!repoKey) {
      used.add(w.workspaceId);
      clusters.push({
        key: w.workspaceId,
        parent: w,
        children: [],
        closed: w.closedWorktrees ?? [],
      });
      continue;
    }
    const family = byRepo.get(repoKey)!;
    const parent = family.find((x) => !x.worktree?.isLinkedWorktree) ?? null;
    const children = family.filter((x) => x.worktree?.isLinkedWorktree);
    const head = parent ?? family[0]!;
    if (w.workspaceId !== head.workspaceId) continue;
    for (const x of family) used.add(x.workspaceId);
    clusters.push({
      key: repoKey,
      repoName: (parent ?? children[0])?.worktree?.repoName,
      parent,
      children,
      closed: uniqueClosed(family),
    });
  }
  return clusters;
}

function clusterMatches(cluster: SpaceCluster, q: string): boolean {
  if (cluster.parent?.label.toLowerCase().includes(q)) return true;
  if (cluster.repoName?.toLowerCase().includes(q)) return true;
  if (cluster.children.some((c) => c.label.toLowerCase().includes(q))) return true;
  if (cluster.closed.some((c) => c.label.toLowerCase().includes(q) || (c.branch ?? "").toLowerCase().includes(q))) {
    return true;
  }
  return false;
}

/** Filter packed groups. A match on a child keeps the parent so the indent still has a home. */
export function filterClusters(clusters: readonly SpaceCluster[], query: string): SpaceCluster[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...clusters];
  return clusters.filter((c) => clusterMatches(c, q));
}

/** Herdr strips the `worktree/` prefix when auto-naming linked checkouts. */
export function shortWorktreeBranch(branch: string): string {
  return branch.startsWith("worktree/") ? branch.slice("worktree/".length) : branch;
}

/**
 * Linked-worktree row label, matching Herdr's `grouped_child_display_label`: a renamed workspace
 * keeps its label; an auto-named one shows the branch.
 */
export function groupedChildDisplayLabel(
  label: string,
  branch: string | null | undefined,
  checkoutPath?: string,
): string {
  if (!branch) return label;
  const short = shortWorktreeBranch(branch);
  const base = checkoutPath?.split(/[/\\]/).filter(Boolean).pop();
  const branchTail = short.split("/").pop() ?? short;
  const autoLike =
    label === short ||
    label === branch ||
    (base !== undefined &&
      (label === base || base.endsWith(`-${label}`) || base.includes(label))) ||
    label.replace(/-/g, "/") === short ||
    label === branchTail ||
    label.includes(branchTail) ||
    branchTail.includes(label);
  return autoLike ? short : label;
}

/** Primary label on a space row. Linked children follow Herdr; parents keep the workspace name. */
export function spaceRowLabel(workspace: WorkspaceView, linkedChild: boolean): string {
  if (!linkedChild) return workspace.label;
  return groupedChildDisplayLabel(
    workspace.label,
    workspace.worktree?.branch,
    workspace.worktree?.checkoutPath,
  );
}

/**
 * Second-row branch line for Herdr's two-row space layout. Linked children suppress git details —
 * the branch already became the primary label.
 */
export function spaceBranchLine(workspace: WorkspaceView, linkedChild: boolean): string | null {
  if (linkedChild) return null;
  const branch = workspace.worktree?.branch;
  return branch ? shortWorktreeBranch(branch) : null;
}

/** Whether a cluster should render as a grouped worktree family (tree connectors + frame). */
export function isWorktreeFamily(cluster: SpaceCluster): boolean {
  return cluster.children.length > 0 || cluster.closed.length > 0;
}
