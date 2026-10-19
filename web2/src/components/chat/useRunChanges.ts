// Sightr code (T31). `resolveRunChanges` for a component: the one clock it needs. An ended run whose checkpoint is still
// `pending` reads "Finishing snapshot" for `FINISHING_GRACE_MS`; this re-resolves when that time has run out, so the card
// and the panel drop to the journal on their own, without waiting for another event.
import type { Run } from "@shared/v2/contracts";
import { useEffect, useMemo, useState } from "react";

import { FINISHING_GRACE_MS, resolveRunChanges, type RunChanges } from "@/lib/runChanges";

import type { RunChangedFiles } from "./ChangedFiles.logic";

export function useRunChanges(run: Run | undefined, journalFiles: RunChangedFiles | null): RunChanges {
  const [now, setNow] = useState(() => Date.now());
  const waiting = run !== undefined && run.status !== "running" && run.checkpoint?.status === "pending";
  const deadline = waiting ? (run.completedAt ?? now) + FINISHING_GRACE_MS : null;
  useEffect(() => {
    if (deadline === null) return;
    const wait = deadline - Date.now();
    if (wait <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), wait + 5);
    return () => clearTimeout(timer);
  }, [deadline]);
  return useMemo(() => resolveRunChanges({ run: run ?? null, journalFiles, now }), [run, journalFiles, now]);
}
