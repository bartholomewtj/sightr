// The service-worker update logic behind lib/pwa.ts, with its browser seams injected so it can be
// unit-tested without a real service worker (spec 10).
//
// Three ways to a fresh bundle, lightest first:
//  - the 60s `registration.update()` poll in lib/pwa.ts;
//  - `onServerBuild`: the bridge stamps `X-Sightr-Build` on every poll and SSE `build` event, so the
//    moment it names a build other than the one baked into this bundle we check straight away;
//  - `forceReload`: unregister every worker, then reload. Only for a wedged precache (the server
//    serves another build but no newer worker turns up), and at most once per server build per tab
//    session, so a load that still doesn't match can never loop.

/** How long a found worker gets to activate before we treat the precache as wedged. */
export const FORCE_RELOAD_MS = 10_000;

/** sessionStorage key: the server build we already force-reloaded for in this tab. */
export const FORCED_BUILD_KEY = "sightr.forcedReloadFor";

export interface UpdateDeps {
  /** The build id baked into this bundle (`__BUILD_INFO__.id`). */
  appBuild: string;
  registration: () => ServiceWorkerRegistration | undefined;
  reload: () => void;
  unregisterAll: () => Promise<void>;
  storage: () => Pick<Storage, "getItem" | "setItem"> | null;
  setTimeout: (fn: () => void, ms: number) => unknown;
  /** Was a worker already controlling this page when it loaded? */
  hadController: boolean;
}

export function createUpdater(deps: UpdateDeps) {
  let reloaded = false;
  let hadController = deps.hadController;
  let lastChecked: string | undefined;

  function reloadOnce(): void {
    if (reloaded) return;
    reloaded = true;
    deps.reload();
  }

  async function forceReload(serverBuild: string): Promise<void> {
    if (reloaded) return;
    try {
      const store = deps.storage();
      if (store?.getItem(FORCED_BUILD_KEY) === serverBuild) return;
      store?.setItem(FORCED_BUILD_KEY, serverBuild);
    } catch {
      // No sessionStorage (private mode, blocked site data): without the loop guard, do not force.
      return;
    }
    reloaded = true;
    try {
      await deps.unregisterAll();
    } catch {
      // Reload anyway: the worker we could not unregister still re-checks on the next load.
    }
    deps.reload();
  }

  // A first-ever visit's `controllerchange` is initial control (immediate registration +
  // clientsClaim), not an update, and reloading on it is a spurious flash. Only a change that
  // replaces a prior controller reloads.
  function onControllerChange(): void {
    if (hadController) reloadOnce();
    else hadController = true;
  }

  // Reload as soon as a freshly installed worker reaches "activated", independent of
  // vite-plugin-pwa's own auto-reload.
  function watchWorker(worker: ServiceWorker | null): void {
    if (!worker) return;
    if (worker.state === "activated") {
      reloadOnce();
      return;
    }
    worker.addEventListener("statechange", () => {
      // skipWaiting is set in src/sw.ts, but if a worker still parks in "installed", nudge it.
      if (worker.state === "installed")
        deps.registration()?.waiting?.postMessage({ type: "SKIP_WAITING" });
      if (worker.state === "activated") reloadOnce();
    });
  }

  /** Ask for a newer worker now. With `serverBuild`, a missing or stuck worker means wedged. */
  async function checkForUpdate(serverBuild?: string): Promise<void> {
    const r = deps.registration();
    if (!r) return;
    try {
      await r.update();
    } catch {
      return; // offline or the bridge is restarting; the next observation or poll tries again
    }
    const pending = r.installing ?? r.waiting;
    if (pending) {
      if (r.waiting) r.waiting.postMessage({ type: "SKIP_WAITING" });
      watchWorker(pending);
      if (serverBuild !== undefined)
        deps.setTimeout(() => void forceReload(serverBuild), FORCE_RELOAD_MS);
      return;
    }
    if (serverBuild !== undefined) await forceReload(serverBuild);
  }

  /** Feed every observed `X-Sightr-Build`. Acts once per new id that differs from this bundle. */
  function onServerBuild(id: string | null | undefined): void {
    if (!id || id === "unknown" || id === deps.appBuild || id === lastChecked) return;
    // Not registered yet (or no worker at all, as under `vite dev`): lib/pwa.ts re-feeds the
    // latest id once registration lands.
    if (!deps.registration()) return;
    lastChecked = id;
    void checkForUpdate(id);
  }

  return { onServerBuild, checkForUpdate, forceReload, onControllerChange, watchWorker };
}
