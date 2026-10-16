// From web/src/lib/server-build.ts: the build id the bridge reports for the bundle it serves, for
// Settings → Connection and for the service-worker update check (lib/pwa.ts). The shell stream's
// `build` frame feeds it (stream/shell-stream.ts), and Settings asks once when it opens
// (api.ts `fetchServerBuild`).
import { useEffect, useSyncExternalStore } from "react";

import { fetchServerBuild } from "./api";

let current: string | undefined;
const listeners = new Set<() => void>();

/** Record a build id; null/undefined (a bridge that does not say) keeps the last good value. */
export function observeServerBuild(id: string | null | undefined): void {
  if (id == null) return;
  current = id;
  for (const fn of listeners) fn();
}

export function getServerBuild(): string | undefined {
  return current;
}

export function subscribeServerBuild(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const subscribe = subscribeServerBuild;

/** The latest server build id, asked for on mount; undefined until it lands. */
export function useServerBuild(): string | undefined {
  useEffect(() => {
    fetchServerBuild()
      .then(observeServerBuild)
      .catch(() => {});
  }, []);
  return useSyncExternalStore(subscribe, getServerBuild, getServerBuild);
}

/** Test helper. */
export function __resetServerBuild(): void {
  current = undefined;
  listeners.clear();
}
