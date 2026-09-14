import { useCallback, useState } from "react";

import type { RecentDir } from "@/lib/triage";

// Dashboard layout preferences, persisted in localStorage. Deliberately separate from
// use-display-prefs (which is about the terminal mirror) — these are about the tree / switcher.
// Safe in SSR contexts: every localStorage touch is guarded.

export interface DashPrefs {
  /**
   * Per-space explicit expansion choice. `undefined` / absent means "never chosen" —
   * a space whose worst bucket is "needs" starts expanded, others start collapsed.
   */
  spaceOpen: Record<string, boolean>;
  /** Tab IDs whose pane list is expanded (tabs with >= 2 panes). */
  expandedTabs: string[];
  /**
   * Whether the Shells section of the pane switcher is expanded. `null` = never chosen, so the
   * count decides — a herd with 37 bare shells shouldn't bury the agents you actually switch to.
   */
  shellsOpen: boolean | null;
  /** Whether the Recent section is expanded. Defaults open — it's the recency list itself. */
  recentOpen: boolean;
  /** Which way Recent runs. Attention sections are never affected. */
  recentDir: RecentDir;
}

const STORAGE_KEY = "sightr:dash-prefs:v2";

/** Above this many rows, an un-chosen foldable section starts collapsed. */
export const COLLAPSE_THRESHOLD = 8;

const DEFAULTS: DashPrefs = {
  spaceOpen: {},
  expandedTabs: [],
  shellsOpen: null,
  recentOpen: true,
  recentDir: "newest",
};

/**
 * The effective open state of a count-sensitive section: an explicit choice always wins, otherwise
 * it opens only while it's short enough to be worth showing. Used by Shells in the pane switcher —
 * a two-item list shouldn't greet you as a mystery collapsed header, and a forty-item one
 * shouldn't greet you as a wall.
 */
export function openForCount(pref: boolean | null, count: number): boolean {
  if (pref !== null) return pref;
  return count <= COLLAPSE_THRESHOLD;
}

/**
 * Coerce an untrusted parsed value into {@link DashPrefs}, filling anything missing or wrong-typed
 * from the defaults. Pure + exported so the file-shape handling is unit-tested.
 */
export function coerceDashPrefs(raw: unknown): DashPrefs {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULTS };
  const p = raw as Record<string, unknown>;

  const rawSpaceOpen =
    typeof p.spaceOpen === "object" && p.spaceOpen !== null && !Array.isArray(p.spaceOpen)
      ? (p.spaceOpen as Record<string, unknown>)
      : null;
  const spaceOpen: Record<string, boolean> = {};
  if (rawSpaceOpen) {
    for (const [k, v] of Object.entries(rawSpaceOpen)) {
      if (typeof v === "boolean") spaceOpen[k] = v;
    }
  }

  const expandedTabs = Array.isArray(p.expandedTabs)
    ? p.expandedTabs.filter((x): x is string => typeof x === "string")
    : DEFAULTS.expandedTabs;

  return {
    spaceOpen,
    expandedTabs,
    shellsOpen: typeof p.shellsOpen === "boolean" ? p.shellsOpen : DEFAULTS.shellsOpen,
    recentOpen: typeof p.recentOpen === "boolean" ? p.recentOpen : DEFAULTS.recentOpen,
    recentDir: p.recentDir === "oldest" || p.recentDir === "newest" ? p.recentDir : DEFAULTS.recentDir,
  };
}

function loadPrefs(): DashPrefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { ...DEFAULTS };
    return coerceDashPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

function savePrefs(prefs: DashPrefs): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    }
  } catch {
    // Ignore quota / SSR write errors — a lost layout preference is not worth a broken render.
  }
}

export interface UseDashPrefsReturn {
  prefs: DashPrefs;
  setSpaceOpen: (workspaceId: string, open: boolean) => void;
  expandSpace: (workspaceId: string) => void;
  setTabOpen: (tabId: string, open: boolean) => void;
  toggleTab: (tabId: string) => void;
  setShellsOpen: (open: boolean) => void;
  setRecentOpen: (open: boolean) => void;
  setRecentDir: (dir: RecentDir) => void;
}

export function useDashPrefs(): UseDashPrefsReturn {
  const [prefs, setPrefs] = useState<DashPrefs>(loadPrefs);

  const update = useCallback((patch: Partial<DashPrefs> | ((prev: DashPrefs) => DashPrefs)) => {
    setPrefs((p) => {
      const next: DashPrefs = typeof patch === "function" ? patch(p) : { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  const setSpaceOpen = useCallback(
    (workspaceId: string, open: boolean) => {
      update((p) => ({
        ...p,
        spaceOpen: { ...p.spaceOpen, [workspaceId]: open },
      }));
    },
    [update],
  );

  const expandSpace = useCallback(
    (workspaceId: string) => {
      setSpaceOpen(workspaceId, true);
    },
    [setSpaceOpen],
  );

  const setTabOpen = useCallback(
    (tabId: string, open: boolean) => {
      update((p) => {
        const exists = p.expandedTabs.includes(tabId);
        if (open && !exists) {
          return { ...p, expandedTabs: [...p.expandedTabs, tabId] };
        } else if (!open && exists) {
          return { ...p, expandedTabs: p.expandedTabs.filter((id) => id !== tabId) };
        }
        return p;
      });
    },
    [update],
  );

  const toggleTab = useCallback(
    (tabId: string) => {
      update((p) => {
        const exists = p.expandedTabs.includes(tabId);
        return {
          ...p,
          expandedTabs: exists
            ? p.expandedTabs.filter((id) => id !== tabId)
            : [...p.expandedTabs, tabId],
        };
      });
    },
    [update],
  );

  const setShellsOpen = useCallback((shellsOpen: boolean) => update({ shellsOpen }), [update]);
  const setRecentOpen = useCallback((recentOpen: boolean) => update({ recentOpen }), [update]);
  const setRecentDir = useCallback((recentDir: RecentDir) => update({ recentDir }), [update]);

  return {
    prefs,
    setSpaceOpen,
    expandSpace,
    setTabOpen,
    toggleTab,
    setShellsOpen,
    setRecentOpen,
    setRecentDir,
  };
}
