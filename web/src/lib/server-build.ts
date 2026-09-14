import { useSyncExternalStore } from "react";

// The build id the bridge reports in the X-Sightr-Build header on every poll response and SSE
// build event. Settings → Connection shows the latest observed value.

// The response header the bridge stamps (bridge/server.ts `BUILD_HEADER`). Kept here so lib/api.ts —
// the only reader — imports one constant rather than hard-coding the string at each fetch site.
import { BUILD_HEADER } from "@shared/limits";

export const SERVER_BUILD_HEADER = BUILD_HEADER;

let current: string | undefined;
const listeners = new Set<() => void>();

/**
 * Record the server build id seen on an API response header. A `null`/`undefined` value (an older
 * bridge that doesn't send the header) is a no-op: the store stays as-is, so nothing downstream
 * activates and we never clobber a good value with "unknown". A real id notifies every subscriber —
 * including on a repeat of the same id, which keeps observation behaviour consistent.
 */
export function observeServerBuild(id: string | null | undefined): void {
  if (id == null) return;
  current = id;
  for (const fn of listeners) fn();
}

/** Non-hook read of the latest observed server build id (for Settings and tests). */
export function getServerBuild(): string | undefined {
  return current;
}

export function subscribeServerBuild(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reactive read of the latest server build id — undefined until the first header lands. */
export function useServerBuild(): string | undefined {
  return useSyncExternalStore(subscribeServerBuild, getServerBuild, getServerBuild);
}
