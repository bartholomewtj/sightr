import { canonicalAgent } from "../../shared/agents.ts";
import {
  type ArchiveReason,
  type Project,
  type Run,
  type RuntimeRequest,
  type RuntimeRequestKind,
  type ThreadCapabilities,
  type ThreadStatus,
  worstStatus,
} from "../../shared/v2/contracts.ts";
import type { AgentStatus } from "../../shared/wire.ts";
import { ACTIVITY_KEY, type ActivityLedger, type PaneActivity } from "../activity.ts";
import type { AgentSessionRef, JournalAdapter } from "../journal/types.ts";
import type { AgentView, EngineSnapshot, StateEngine } from "../state-engine.ts";
import { capabilitiesFor, SHELL_HARNESS } from "./capabilities.ts";
import { MAX_TITLE_LENGTH } from "./decide.ts";
import type { EventDraft, ServerThread, ServerThreadPatch } from "./events.ts";
import { requestEvents } from "./request-items.ts";
import type { ThreadStore } from "./store.ts";

// Herd ingest (T02): herdr workspaces become projects, panes become threads. The engine's snapshot
// is diffed against the store's projection by the pure `diffHerd`, and the result is one
// `store.append`. Nothing here talks to Herdr, and the activity ledger is only read: "seen" stays in
// activity.json (ADR 0003), so v1 and v2 agree on what is unread.

/** How long a T07 thread (`starting`, no terminal yet) may be missing from the herd before it counts as gone. */
export const STARTING_GRACE_MS = 60_000;

/** A thread's identity: `(paneId, terminalId)`. A pane with no terminal id (old herdr) keys on "". */
export function threadKey(paneId: string, terminalId: string | undefined): string {
  return `${paneId}\u0000${terminalId ?? ""}`;
}

/** The v1 unread rule (activity.ts): done, and active since you last looked. */
export function isUnreadDone(status: AgentStatus, activity: PaneActivity | undefined): boolean {
  return status === "done" && activity !== undefined && activity.activeAt > activity.seenAt;
}

/**
 * A thread's status from the published herdr status. `blocked` is `approval` when a pending runtime
 * request asks for a permission or trust decision (T04), else `input`. A resting pane keeps a `failed`
 * that T03 set; T03 clears it when the next run starts.
 */
export function threadStatusFor(
  herd: AgentStatus,
  unreadDone: boolean,
  openKinds: readonly RuntimeRequestKind[] = [],
  previous?: ThreadStatus,
): ThreadStatus {
  switch (herd) {
    case "working":
      return "working";
    case "blocked":
      return openKinds.some((k) => k === "permission" || k === "trust") ? "approval" : "input";
    default:
      if (previous === "failed") return "failed";
      return unreadDone ? "done" : "idle";
  }
}

/** The harness a pane's thread carries: `shell` for a bare shell, else the canonical agent id (raw when unknown). */
export function harnessFor(pane: AgentView): string {
  if (pane.kind === "shell") return SHELL_HARNESS;
  return canonicalAgent(pane.agent) || pane.agent;
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/** The herd's title for a pane: the first name it has, else `<harness> · <tab or folder>`. */
export function herdTitle(pane: AgentView, harness: string): string {
  const named = [pane.paneLabel, pane.sessionName, pane.agentName, pane.terminalTitle, pane.summary]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .find((v) => v !== "");
  const title = named ?? (() => {
    const where = pane.tabLabel?.trim() || basename(pane.cwd ?? "");
    return where ? `${harness} · ${where}` : harness;
  })();
  return title.slice(0, MAX_TITLE_LENGTH);
}

// ── The pure diff ────────────────────────────────────────────────────────────────────────────────

export interface HerdProjection {
  projects: readonly Project[];
  threads: readonly ServerThread[];
  openRuns: readonly Run[];
  pendingRequests: readonly RuntimeRequest[];
}

export interface HerdDiffContext {
  now: number;
  newId: () => string;
  /** The first reconcile since start: a thread whose pane is gone was closed while the bridge was down. */
  first: boolean;
  /** Threads (by id) and projects (by id) already missing at the previous reconcile. */
  missingThreads: ReadonlySet<string>;
  missingProjects: ReadonlySet<string>;
  /** The ledger's entry for a pane. */
  activity: (paneId: string) => PaneActivity | undefined;
  /** When the engine last reported a status transition for the pane, since start. */
  touchedAt: (paneId: string) => number | undefined;
  capabilities: (harness: string) => ThreadCapabilities;
}

export interface HerdDiff {
  events: EventDraft[];
  /** Missing for the first time at this reconcile; archived (closed) if still missing at the next one. */
  missingThreads: Set<string>;
  missingProjects: Set<string>;
}

interface DesiredWorkspace {
  label: string;
  number: number;
  repoKey?: string;
  worktreeOf?: string;
}

const sameRef = (a: AgentSessionRef | undefined, b: AgentSessionRef | undefined) =>
  a?.kind === b?.kind && a?.value === b?.value;

const sameCapabilities = (a: ThreadCapabilities, b: ThreadCapabilities) => JSON.stringify(a) === JSON.stringify(b);

function sameProject(a: Project, b: Project): boolean {
  return (
    a.label === b.label &&
    a.labelSource === b.labelSource &&
    a.number === b.number &&
    a.order === b.order &&
    a.repoKey === b.repoKey &&
    a.worktreeOf === b.worktreeOf &&
    a.status === b.status &&
    a.closedAt === b.closedAt
  );
}

function applyPatch(thread: ServerThread, patch: ServerThreadPatch, at: number): ServerThread {
  const { sessionRef, ...rest } = patch;
  const next: ServerThread = { ...thread, ...rest, updatedAt: at };
  if (sessionRef === null) delete next.sessionRef;
  else if (sessionRef !== undefined) next.sessionRef = sessionRef;
  return next;
}

/**
 * The events that bring the projection in line with the herd. Pure: the same inputs always give the
 * same events, and a snapshot the projection already matches gives none.
 *
 * Order: project upserts for live workspaces (so a new thread's project exists), then thread events,
 * then closed projects.
 */
export function diffHerd(snap: EngineSnapshot, projection: HerdProjection, ctx: HerdDiffContext): HerdDiff {
  const at = ctx.now;
  const threadEvents: EventDraft[] = [];
  const next = new Map(projection.threads.map((t) => [t.id, t]));
  const byKey = new Map(projection.threads.map((t) => [threadKey(t.paneId, t.terminalId), t]));
  const byPane = new Map<string, ServerThread[]>();
  for (const t of projection.threads) {
    if (t.shelf === "archived") continue;
    byPane.set(t.paneId, [...(byPane.get(t.paneId) ?? []), t]);
  }
  const kinds = new Map<string, RuntimeRequestKind[]>();
  for (const r of projection.pendingRequests) kinds.set(r.threadId, [...(kinds.get(r.threadId) ?? []), r.kind]);

  const patch = (threadId: string, p: ServerThreadPatch) => {
    threadEvents.push({ type: "thread.updated", threadId, payload: { patch: p, at } });
    next.set(threadId, applyPatch(next.get(threadId)!, p, at));
  };
  const shelfActive = (threadId: string) => {
    threadEvents.push({ type: "thread.shelf-changed", threadId, payload: { shelf: "active", at } });
    const t = { ...next.get(threadId)!, shelf: "active" as const, updatedAt: at };
    delete t.snoozedUntil;
    delete t.pinnedAt;
    delete t.pinOrder;
    delete t.settledAt;
    delete t.archivedAt;
    delete t.archiveReason;
    next.set(threadId, t);
  };
  const archive = (thread: ServerThread, reason: ArchiveReason) => {
    for (const run of projection.openRuns) {
      if (run.threadId !== thread.id) continue;
      threadEvents.push({
        type: "run.ended",
        threadId: thread.id,
        payload: { runId: run.id, status: "interrupted", completedAt: at },
      });
    }
    for (const request of projection.pendingRequests) {
      if (request.threadId !== thread.id) continue;
      threadEvents.push(...requestEvents({ ...request, status: "expired", updatedAt: at }));
    }
    threadEvents.push({ type: "thread.archived", threadId: thread.id, payload: { reason, at } });
    next.set(thread.id, { ...next.get(thread.id)!, shelf: "archived", archivedAt: at, archiveReason: reason, updatedAt: at });
  };

  const panes = [...snap.agents, ...snap.shellPanes];
  const livePanes = new Set(panes.map((p) => p.paneId));
  const claimed = new Set<string>();

  for (const pane of panes) {
    const terminalId = pane.terminalId ?? "";
    const onPane = byPane.get(pane.paneId) ?? [];
    let thread = byKey.get(threadKey(pane.paneId, terminalId));
    let adopted = false;
    // T07 created this thread before herdr reported the pane's terminal: adopt it, do not make a second.
    if (!thread && terminalId !== "") {
      thread = onPane.find((t) => t.terminalId === "");
      adopted = thread !== undefined;
    }
    // Any other live thread on this pane belonged to an earlier terminal.
    for (const other of onPane) {
      if (other.id === thread?.id) continue;
      claimed.add(other.id);
      archive(other, "terminal-replaced");
    }

    const harness = harnessFor(pane);
    const capabilities = ctx.capabilities(harness);
    const activity = ctx.activity(pane.paneId);
    const unreadDone = isUnreadDone(pane.status, activity);
    const lastActivityAt = ctx.touchedAt(pane.paneId) ?? activity?.activeAt;

    if (!thread) {
      const created: ServerThread = {
        id: ctx.newId(),
        paneId: pane.paneId,
        terminalId,
        projectId: pane.workspaceId,
        title: herdTitle(pane, harness),
        titleSource: "herd",
        harness,
        status: threadStatusFor(pane.status, unreadDone),
        shelf: "active",
        unreadDone,
        lastActivityAt: lastActivityAt ?? at,
        createdAt: at,
        updatedAt: at,
        capabilities,
        ...(pane.agentSession ? { sessionRef: pane.agentSession } : {}),
      };
      threadEvents.push({ type: "thread.created", threadId: created.id, payload: { thread: created } });
      next.set(created.id, created);
      continue;
    }

    claimed.add(thread.id);
    if (thread.shelf === "archived") {
      // The pane came back after we gave up on it: it is the same pane and terminal, so revive it.
      // A thread the operator archived stays archived (unarchive is theirs).
      if (thread.archiveReason !== "pane-closed" && thread.archiveReason !== "closed-while-down") continue;
      shelfActive(thread.id);
    }

    const current = next.get(thread.id)!;
    const p: ServerThreadPatch = {};
    if (adopted) p.terminalId = terminalId;
    if (current.harness !== harness) p.harness = harness;
    if (!sameCapabilities(current.capabilities, capabilities)) p.capabilities = capabilities;
    if (current.titleSource === "herd") {
      const title = herdTitle(pane, harness);
      if (current.title !== title) p.title = title;
    }
    if (current.unreadDone !== unreadDone) p.unreadDone = unreadDone;
    const status = threadStatusFor(pane.status, unreadDone, kinds.get(thread.id), current.status);
    if (current.status !== status) p.status = status;
    if (lastActivityAt !== undefined && current.lastActivityAt !== lastActivityAt) p.lastActivityAt = lastActivityAt;
    if (!sameRef(current.sessionRef, pane.agentSession)) p.sessionRef = pane.agentSession ?? null;
    if (Object.keys(p).length > 0) patch(thread.id, p);

    // A snoozed or settled thread that finishes work comes back to the active list.
    if ((current.shelf === "snoozed" || current.shelf === "settled") && current.status === "working" && status !== "working") {
      shelfActive(thread.id);
    }
  }

  // Panes that are gone. Two looks in a row (a partial snapshot can drop a pane once), or one look on
  // the first reconcile after a restart, when the herd is the truth.
  const missingThreads = new Set<string>();
  for (const thread of projection.threads) {
    if (claimed.has(thread.id) || thread.shelf === "archived" || livePanes.has(thread.paneId)) continue;
    if (ctx.first) {
      archive(thread, "closed-while-down");
      continue;
    }
    // T07 is spawning this pane and herdr may not list it yet.
    if (thread.status === "starting" && thread.terminalId === "" && at - thread.updatedAt < STARTING_GRACE_MS) continue;
    if (ctx.missingThreads.has(thread.id)) archive(thread, "pane-closed");
    else missingThreads.add(thread.id);
  }

  // Snooze expiry.
  for (const thread of next.values()) {
    if (thread.shelf === "snoozed" && thread.snoozedUntil !== undefined && thread.snoozedUntil <= at) shelfActive(thread.id);
  }

  // Projects: one per workspace (and per workspace a pane names that the list missed).
  const workspaces = new Map<string, DesiredWorkspace>();
  for (const w of snap.workspaces) {
    workspaces.set(w.workspaceId, {
      label: w.label || w.workspaceId,
      number: w.number,
      ...(w.worktree ? { repoKey: w.worktree.repoKey } : {}),
      ...(w.worktree?.isLinkedWorktree ? { worktreeOf: w.worktree.repoKey } : {}),
    });
  }
  for (const pane of panes) {
    if (!workspaces.has(pane.workspaceId)) {
      workspaces.set(pane.workspaceId, { label: pane.workspaceLabel || pane.workspaceId, number: pane.workspaceNumber });
    }
  }
  const statuses = new Map<string, ThreadStatus[]>();
  for (const t of next.values()) {
    if (t.shelf !== "active" && t.shelf !== "pinned") continue;
    statuses.set(t.projectId, [...(statuses.get(t.projectId) ?? []), t.status]);
  }
  const rollUp = (projectId: string) => worstStatus(statuses.get(projectId) ?? []);

  const projectEvents: EventDraft[] = [];
  const closeEvents: EventDraft[] = [];
  const known = new Map(projection.projects.map((p) => [p.id, p]));
  for (const [id, w] of workspaces) {
    const existing = known.get(id);
    const user = existing?.labelSource === "user";
    const desired: Project = {
      id,
      label: user ? existing!.label : w.label,
      labelSource: user ? "user" : "herd",
      number: w.number,
      order: w.number,
      ...(w.repoKey !== undefined ? { repoKey: w.repoKey } : {}),
      ...(w.worktreeOf !== undefined ? { worktreeOf: w.worktreeOf } : {}),
      status: rollUp(id),
    };
    if (!existing || !sameProject(existing, desired)) {
      projectEvents.push({ type: "project.upserted", payload: { project: desired } });
    }
  }
  const missingProjects = new Set<string>();
  for (const existing of projection.projects) {
    if (workspaces.has(existing.id)) continue;
    const status = rollUp(existing.id);
    if (status !== existing.status) {
      closeEvents.push({ type: "project.upserted", payload: { project: { ...existing, status } } });
    }
    if (existing.closedAt !== undefined) continue;
    if (ctx.first || ctx.missingProjects.has(existing.id)) {
      closeEvents.push({ type: "project.closed", payload: { projectId: existing.id, closedAt: at } });
    } else {
      missingProjects.add(existing.id);
    }
  }

  return { events: [...projectEvents, ...threadEvents, ...closeEvents], missingThreads, missingProjects };
}

// ── The ingestor ─────────────────────────────────────────────────────────────────────────────────

export interface HerdIngestorDeps {
  store: Pick<ThreadStore, "append" | "listProjects" | "listThreads" | "openRuns" | "pendingRequests">;
  engine: Pick<StateEngine, "onUpdate" | "onTransition">;
  activity: Pick<ActivityLedger, "get">;
  journals: Record<string, JournalAdapter> | null;
  now?: () => number;
  newId?: () => string;
  log?: (msg: string) => void;
}

export interface HerdIngestor {
  start(): void;
  stop(): void;
  /** Bring the store in line with `snap`. Returns how many events it appended. */
  reconcile(snap: EngineSnapshot): number;
}

export function createHerdIngestor(deps: HerdIngestorDeps): HerdIngestor {
  const { store, engine, activity, journals } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((msg: string) => console.warn(msg));

  // When each pane last changed status, since start. The ledger's activeAt is the fallback.
  const touched = new Map<string, number>();
  let first = true;
  let missingThreads: ReadonlySet<string> = new Set();
  let missingProjects: ReadonlySet<string> = new Set();
  const unsubscribe: (() => void)[] = [];

  const reconcile = (snap: EngineSnapshot): number => {
    // A disconnected engine has no herd to compare against; the store is left alone.
    if (snap.bridge !== "connected") return 0;
    try {
      const diff = diffHerd(
        snap,
        {
          projects: store.listProjects(),
          threads: store.listThreads(),
          openRuns: store.openRuns(),
          pendingRequests: store.pendingRequests(),
        },
        {
          now: now(),
          newId,
          first,
          missingThreads,
          missingProjects,
          activity: (paneId) => activity.get(ACTIVITY_KEY, paneId),
          touchedAt: (paneId) => touched.get(paneId),
          capabilities: (harness) => capabilitiesFor(harness, journals),
        },
      );
      if (diff.events.length > 0) store.append(diff.events);
      first = false;
      missingThreads = diff.missingThreads;
      missingProjects = diff.missingProjects;
      const live = new Set([...snap.agents, ...snap.shellPanes].map((p) => p.paneId));
      for (const paneId of [...touched.keys()]) if (!live.has(paneId)) touched.delete(paneId);
      return diff.events.length;
    } catch (err) {
      // Never let the ingest fail the engine's poll; the next poll tries again.
      log(`[threads] herd ingest failed: ${(err as Error).message}`);
      return 0;
    }
  };

  return {
    start() {
      if (unsubscribe.length > 0) return;
      // The engine fires transitions before the update in one poll, so the transition only annotates;
      // reconcile is the single writer.
      unsubscribe.push(engine.onTransition((agent) => touched.set(agent.paneId, now())));
      unsubscribe.push(engine.onUpdate((snap) => void reconcile(snap)));
    },
    stop() {
      for (const off of unsubscribe.splice(0)) off();
    },
    reconcile,
  };
}
