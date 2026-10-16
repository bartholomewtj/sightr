// The thread's folder in the Files root (T13), asked of the bridge so the client never handles the
// absolute cwd (containment stays on the bridge, ADR 0026). `undefined` while loading; null when the
// folder is outside the root, Files is off, or the read failed.
import { useEffect, useState } from "react";

import { fetchPaneFolder } from "@/lib/api";

export interface PaneFolder {
  path: string | null | undefined;
  /** Files is not turned on (no SIGHTR_WORK_ROOT): the bridge answers 404 for every Files route. */
  filesOff: boolean;
}

export function usePaneFolder(paneId: string | null): PaneFolder {
  const [state, setState] = useState<PaneFolder>({ path: undefined, filesOff: false });
  useEffect(() => {
    if (!paneId) {
      setState({ path: null, filesOff: false });
      return;
    }
    setState({ path: undefined, filesOff: false });
    const controller = new AbortController();
    fetchPaneFolder(paneId, controller.signal)
      .then((r) => setState({ path: r.path, filesOff: false }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ path: null, filesOff: (err as { status?: number }).status === 404 });
      });
    return () => controller.abort();
  }, [paneId]);
  return state;
}
