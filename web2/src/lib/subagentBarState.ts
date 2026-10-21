// T34: what the subagent bar remembers per thread, on this device.
//
//  - `hideFinished`: the list shows only running agents ("Hide finished" / "Show finished"). Nothing is
//    removed: the strip's counts and the chat cards still cover every agent, and showing brings them back.
//  - `seen`: the finishes the operator has looked at, as `<agent key>|<phase>`. An agent that is done,
//    failed or stopped and not in `seen` puts the unread dot on the bar; opening the list marks them all.
//
// History is not news. The first time a thread's items are on screen on a device, the time of its newest
// item is kept as a baseline, and only an agent whose newest call is later than that can light the dot.
// (Counting "everything finished at first sight" failed: the older runs load after the first render.)

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ThreadAgent } from "./subagentGroups";

const KEY = (kind: "hide-finished" | "seen" | "baseline", threadId: string) => `sightr:v2:subagents-${kind}:${threadId}`;

/** Most entries kept per thread (a long thread's record must not grow without end). */
const MAX_KEPT = 400;

function readBaseline(threadId: string): number | null {
  try {
    const raw = window.localStorage.getItem(KEY("baseline", threadId));
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeBaseline(threadId: string, at: number): void {
  try {
    window.localStorage.setItem(KEY("baseline", threadId), String(at));
  } catch {
    /* blocked: the bar works, it just forgets */
  }
}

function readHideFinished(threadId: string): boolean {
  try {
    return window.localStorage.getItem(KEY("hide-finished", threadId)) === "1";
  } catch {
    return false;
  }
}

function writeHideFinished(threadId: string, hide: boolean): void {
  try {
    if (hide) window.localStorage.setItem(KEY("hide-finished", threadId), "1");
    else window.localStorage.removeItem(KEY("hide-finished", threadId));
  } catch {
    /* blocked: the bar works, it just forgets */
  }
}

function read(kind: "seen", threadId: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(KEY(kind, threadId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return null;
  }
}

function write(kind: "seen", threadId: string, values: Iterable<string>): void {
  try {
    window.localStorage.setItem(KEY(kind, threadId), JSON.stringify([...values].slice(-MAX_KEPT)));
  } catch {
    /* storage full or blocked: the bar works, it just forgets */
  }
}

export const seenKeyOf = (agent: ThreadAgent): string => `${agent.key}|${agent.phase}`;

export interface SubagentBarState {
  /** Every agent of the thread, in list order: what the strip counts. */
  visible: ThreadAgent[];
  /** The agents the list shows: all of them, or only the running ones while finished are hidden. */
  listed: ThreadAgent[];
  hideFinished: boolean;
  /** Finished agents (done, failed, stopped) the operator has not looked at yet. */
  unseen: ThreadAgent[];
  /** Any unseen agent failed: the dot is the destructive colour. */
  unseenFailed: boolean;
  /** Everything finished so far counts as seen. */
  markSeen: () => void;
  /** Flip between showing finished agents in the list and hiding them. */
  toggleHideFinished: () => void;
  finishedCount: number;
}

export function useSubagentBarState(
  threadId: string,
  agents: readonly ThreadAgent[],
  /** The time of the thread's newest item as loaded now (any kind), or null while nothing is loaded. */
  newestItemAt: number | null,
): SubagentBarState {
  const [hideFinished, setHideFinished] = useState<boolean>(() => readHideFinished(threadId));
  const [seen, setSeen] = useState<Set<string>>(() => new Set(read("seen", threadId) ?? []));
  const [baseline, setBaseline] = useState<number | null>(() => readBaseline(threadId));

  // A different thread: load its record.
  useEffect(() => {
    setHideFinished(readHideFinished(threadId));
    setSeen(new Set(read("seen", threadId) ?? []));
    setBaseline(readBaseline(threadId));
  }, [threadId]);

  // First sight of a thread's items on this device: what is already in it is history.
  useEffect(() => {
    if (baseline !== null || newestItemAt === null) return;
    setBaseline(newestItemAt);
    writeBaseline(threadId, newestItemAt);
  }, [baseline, newestItemAt, threadId]);

  const finished = useMemo(() => agents.filter((a) => a.phase !== "running"), [agents]);

  const visible = useMemo(() => [...agents], [agents]);
  const listed = useMemo(() => (hideFinished ? agents.filter((a) => a.phase === "running") : [...agents]), [agents, hideFinished]);
  const unseen = useMemo(
    () =>
      baseline === null
        ? []
        : visible.filter((a) => a.phase !== "running" && a.lastAt > baseline && !seen.has(seenKeyOf(a))),
    [visible, seen, baseline],
  );

  const markSeen = useCallback(() => {
    setSeen((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const a of finished) {
        const k = seenKeyOf(a);
        if (!next.has(k)) {
          next.add(k);
          changed = true;
        }
      }
      if (!changed) return prev;
      write("seen", threadId, next);
      return next;
    });
  }, [finished, threadId]);

  const toggleHideFinished = useCallback(() => {
    setHideFinished((prev) => {
      writeHideFinished(threadId, !prev);
      return !prev;
    });
  }, [threadId]);

  return {
    visible,
    listed,
    hideFinished,
    unseen,
    unseenFailed: unseen.some((a) => a.phase === "failed"),
    markSeen,
    toggleHideFinished,
    finishedCount: finished.length,
  };
}
