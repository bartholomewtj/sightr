// T34: what the subagent bar remembers per thread, on this device.
//
//  - `dismissed`: agents the operator cleared from the bar ("Clear finished"). They stay in the chat card.
//  - `seen`: the finishes the operator has looked at, as `<agent key>|<phase>`. An agent that is done,
//    failed or stopped and not in `seen` puts the unread dot on the bar; opening the list marks them all.
//
// History is not news. The first time a thread's items are on screen on a device, the time of its newest
// item is kept as a baseline, and only an agent whose newest call is later than that can light the dot.
// (Counting "everything finished at first sight" failed: the older runs load after the first render.)

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ThreadAgent } from "./subagentGroups";

const KEY = (kind: "dismissed" | "seen" | "baseline", threadId: string) => `sightr:v2:subagents-${kind}:${threadId}`;

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

function read(kind: "dismissed" | "seen", threadId: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(KEY(kind, threadId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return null;
  }
}

function write(kind: "dismissed" | "seen", threadId: string, values: Iterable<string>): void {
  try {
    window.localStorage.setItem(KEY(kind, threadId), JSON.stringify([...values].slice(-MAX_KEPT)));
  } catch {
    /* storage full or blocked: the bar works, it just forgets */
  }
}

export const seenKeyOf = (agent: ThreadAgent): string => `${agent.key}|${agent.phase}`;

export interface SubagentBarState {
  /** The agents the bar lists: the thread's, less the dismissed. Same order. */
  visible: ThreadAgent[];
  /** Finished agents (done, failed, stopped) the operator has not looked at yet. */
  unseen: ThreadAgent[];
  /** Any unseen agent failed: the dot is the destructive colour. */
  unseenFailed: boolean;
  /** Everything finished so far counts as seen. */
  markSeen: () => void;
  /** Take every finished agent off the bar. */
  clearFinished: () => void;
  finishedCount: number;
}

export function useSubagentBarState(
  threadId: string,
  agents: readonly ThreadAgent[],
  /** The time of the thread's newest item as loaded now (any kind), or null while nothing is loaded. */
  newestItemAt: number | null,
): SubagentBarState {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set(read("dismissed", threadId) ?? []));
  const [seen, setSeen] = useState<Set<string>>(() => new Set(read("seen", threadId) ?? []));
  const [baseline, setBaseline] = useState<number | null>(() => readBaseline(threadId));

  // A different thread: load its record.
  useEffect(() => {
    setDismissed(new Set(read("dismissed", threadId) ?? []));
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

  const visible = useMemo(() => agents.filter((a) => !dismissed.has(a.key)), [agents, dismissed]);
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

  const clearFinished = useCallback(() => {
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const a of finished) next.add(a.key);
      write("dismissed", threadId, next);
      return next;
    });
  }, [finished, threadId]);

  return {
    visible,
    unseen,
    unseenFailed: unseen.some((a) => a.phase === "failed"),
    markSeen,
    clearFinished,
    finishedCount: visible.filter((a) => a.phase !== "running").length,
  };
}
