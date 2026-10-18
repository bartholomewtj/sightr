// Same job and name as T3 Code apps/web/src/diffPanelStore.ts @ 3a4d118a518a (pattern; MIT, see THIRD_PARTY.md).
// T3 keeps one selection per thread (branch with a base, unstaged, or a turn that carries the file to reveal and
// a `revealRequestId`). Sightr keeps the same per-thread selection as `scopes` (working tree, branch with an
// optional base, or one run), persisted with the right-panel store's safe-storage wrapper, and lifts the reveal
// out into its own field, because the Git tab needs the same tap-through for the other two scopes. A new
// `requestId` on every call makes a second tap on the same file scroll again. Not taken: Effect atoms, T3's
// `scopedThreadKey` (one environment here) and `reconcileTurnSelection` (a run that is gone shows as empty).
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { openRightPanelSurface } from "@/rightPanelStore";

/** What the Diff tab compares. `baseRef` absent means the bridge's default base (upstream, then origin/HEAD, main, master). */
export type DiffScope = { kind: "workingTree" } | { kind: "branch"; baseRef?: string } | { kind: "run"; runId: string };

export const WORKING_TREE: DiffScope = { kind: "workingTree" };
const DIFF_PANEL_STORAGE_KEY = "sightr:v2:diff-panel:v1";
/** Threads whose scope is remembered; the newest (last opened) stay. */
export const DIFF_SCOPE_THREAD_CAP = 50;

/** A request to unfold one file and scroll to it. Never persisted. */
export interface DiffReveal {
  threadId: string;
  filePath: string;
  requestId: number;
}

interface DiffPanelState {
  scopes: Record<string, DiffScope>;
  /** Thread ids, oldest first: what the cap drops. */
  recent: string[];
  reveal: DiffReveal | null;
  setScope: (threadId: string, scope: DiffScope) => void;
  /** Set the scope, ask for `filePath` (if any) to be revealed, and open the Diff tab (the desktop tab, or the phone sheet). */
  openDiff: (threadId: string, scope: DiffScope, filePath?: string) => void;
  /** What T24's changed-files card calls: one run's files. */
  openDiffForRun: (threadId: string, runId: string, filePath?: string) => void;
  consumeReveal: (requestId: number) => void;
}

/** localStorage behind try/catch: a private window keeps the state for the page only (as rightPanelStore.ts). */
const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      /* memory stays authoritative */
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

let nextRequestId = 1;

/** A stored scope, or the working tree for anything unknown or corrupt. */
export function sanitizeScope(value: unknown): DiffScope {
  if (typeof value !== "object" || value === null) return WORKING_TREE;
  const v = value as Record<string, unknown>;
  if (v.kind === "branch") {
    return typeof v.baseRef === "string" && v.baseRef.trim() !== "" ? { kind: "branch", baseRef: v.baseRef.trim() } : { kind: "branch" };
  }
  if (v.kind === "run" && typeof v.runId === "string" && v.runId !== "") return { kind: "run", runId: v.runId };
  return WORKING_TREE;
}

/** A key for a scope that is stable and filename-safe: scroll and fold memory are kept per thread and scope. */
export function scopeKey(scope: DiffScope): string {
  return scope.kind === "workingTree" ? "w" : scope.kind === "branch" ? `b:${scope.baseRef ?? ""}` : `r:${scope.runId}`;
}

export function sameScope(a: DiffScope, b: DiffScope): boolean {
  return scopeKey(a) === scopeKey(b);
}

const initial = () => ({ scopes: {} as Record<string, DiffScope>, recent: [] as string[], reveal: null as DiffReveal | null });

function withScope(state: Pick<DiffPanelState, "scopes" | "recent">, threadId: string, scope: DiffScope) {
  const recent = [...state.recent.filter((id) => id !== threadId), threadId];
  const scopes = { ...state.scopes, [threadId]: scope };
  while (recent.length > DIFF_SCOPE_THREAD_CAP) delete scopes[recent.shift() as string];
  return { scopes, recent };
}

export const useDiffPanelStore = create<DiffPanelState>()(
  persist(
    (set, get) => ({
      ...initial(),
      setScope: (threadId, scope) => set((s) => withScope(s, threadId, scope)),
      openDiff: (threadId, scope, filePath) => {
        set((s) => ({
          ...withScope(s, threadId, scope),
          reveal: filePath ? { threadId, filePath, requestId: nextRequestId++ } : null,
        }));
        openRightPanelSurface("diff");
      },
      openDiffForRun: (threadId, runId, filePath) => get().openDiff(threadId, { kind: "run", runId }, filePath),
      consumeReveal: (requestId) => {
        if (get().reveal?.requestId === requestId) set({ reveal: null });
      },
    }),
    {
      name: DIFF_PANEL_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ scopes: s.scopes, recent: s.recent }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as { scopes?: unknown; recent?: unknown };
        const scopes: Record<string, DiffScope> = {};
        if (typeof p.scopes === "object" && p.scopes !== null && !Array.isArray(p.scopes)) {
          for (const [id, value] of Object.entries(p.scopes)) scopes[id] = sanitizeScope(value);
        }
        const listed = Array.isArray(p.recent) ? p.recent.filter((id): id is string => typeof id === "string" && id in scopes) : [];
        // A thread with a scope but no place in the order is the oldest.
        const recent = [...Object.keys(scopes).filter((id) => !listed.includes(id)), ...listed].slice(-DIFF_SCOPE_THREAD_CAP);
        for (const id of Object.keys(scopes)) if (!recent.includes(id)) delete scopes[id];
        return { ...current, scopes, recent };
      },
    },
  ),
);

/** The thread's scope (the working tree until one is picked). */
export function useDiffScope(threadId: string): DiffScope {
  return useDiffPanelStore((s) => s.scopes[threadId]) ?? WORKING_TREE;
}

/** Test helper: back to defaults, storage re-read. */
export function __resetDiffPanelStore(): void {
  const raw = safeStorage.getItem(DIFF_PANEL_STORAGE_KEY) as string | null;
  useDiffPanelStore.setState(initial());
  if (raw === null) safeStorage.removeItem(DIFF_PANEL_STORAGE_KEY);
  else safeStorage.setItem(DIFF_PANEL_STORAGE_KEY, raw);
  void useDiffPanelStore.persist.rehydrate();
}
