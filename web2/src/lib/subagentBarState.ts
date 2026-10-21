// T34: what the subagent bar remembers per thread, on this device.
//
//  - `dismissed`: agents the operator cleared from the bar ("Clear finished"). They stay in the chat card.
//  - `seen`: the finishes the operator has looked at, as `<agent key>|<phase>`. An agent that is done,
//    failed or stopped and not in `seen` puts the unread dot on the bar; opening the list marks them all.
//
// The first time a thread is opened on a device nothing is unread: everything already finished is taken
// as seen, so history never lights the bar.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ThreadAgent } from "./subagentGroups";

const KEY = (kind: "dismissed" | "seen", threadId: string) => `sightr:v2:subagents-${kind}:${threadId}`;

/** Most entries kept per thread (a long thread's record must not grow without end). */
const MAX_KEPT = 400;

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

export function useSubagentBarState(threadId: string, agents: readonly ThreadAgent[]): SubagentBarState {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set(read("dismissed", threadId) ?? []));
  const [seen, setSeen] = useState<Set<string> | null>(() => {
    const stored = read("seen", threadId);
    return stored === null ? null : new Set(stored);
  });

  // A different thread: load its record.
  useEffect(() => {
    setDismissed(new Set(read("dismissed", threadId) ?? []));
    const stored = read("seen", threadId);
    setSeen(stored === null ? null : new Set(stored));
  }, [threadId]);

  const finished = useMemo(() => agents.filter((a) => a.phase !== "running"), [agents]);

  // First sight of a thread on this device: what has already finished is not news.
  useEffect(() => {
    if (seen !== null) return;
    const initial = new Set(finished.map(seenKeyOf));
    setSeen(initial);
    write("seen", threadId, initial);
  }, [seen, finished, threadId]);

  const visible = useMemo(() => agents.filter((a) => !dismissed.has(a.key)), [agents, dismissed]);
  const unseen = useMemo(
    () => (seen === null ? [] : visible.filter((a) => a.phase !== "running" && !seen.has(seenKeyOf(a)))),
    [visible, seen],
  );

  const markSeen = useCallback(() => {
    setSeen((prev) => {
      const next = new Set(prev ?? []);
      let changed = prev === null;
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
