import { registerSW } from "virtual:pwa-register";

import { createUpdater } from "@v1/lib/pwa-update";

import { getServerBuild, subscribeServerBuild } from "./server-build";
import { isOwnScope, isOwnWorker } from "./sw-routes";

// Registers web2's worker (`<base>sw.js`, scope `<base>`; `/` since the T15 cutover, the URL and scope
// v1's worker had) and keeps it current the way v1 does (spec 10, web/src/lib/pwa-update.ts):
//  - a `registration.update()` once a minute;
//  - at once when the shell stream's `build` frame names a build other than this bundle's;
//  - unregister-and-reload for a wedged precache, at most once per server build per tab.
// The bridge answers web2's requests with web2's build id and v1's (sent `x-sightr-ui: v1`) with v1's,
// so the two apps never chase each other's builds.
const UPDATE_CHECK_MS = 60_000;
const BASE = import.meta.env.BASE_URL;

let registration: ServiceWorkerRegistration | undefined;

const controller = typeof navigator !== "undefined" ? navigator.serviceWorker?.controller : undefined;

const updater = createUpdater({
  appBuild: __BUILD_INFO__.id,
  registration: () => registration,
  reload: () => window.location.reload(),
  // Only web2's own registration: v1's at /v1/ is not ours to drop.
  unregisterAll: async () => {
    const all = await navigator.serviceWorker.getRegistrations();
    await Promise.all(all.filter((r) => isOwnScope(r.scope, BASE)).map((r) => r.unregister()));
  },
  storage: () => window.sessionStorage,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  // A page first claimed by our worker is not an update; neither is one that was under v1's.
  hadController: isOwnWorker(controller?.scriptURL, BASE),
});

/** Check for a newer worker now (the minute poll does this on its own). */
export const checkForUpdate = () => updater.checkForUpdate();

subscribeServerBuild(() => updater.onServerBuild(getServerBuild()));

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, r) {
    registration = r;
    if (!r) return;
    r.addEventListener("updatefound", () => updater.watchWorker(r.installing));
    navigator.serviceWorker?.addEventListener("controllerchange", updater.onControllerChange);
    setInterval(() => void r.update().catch(() => {}), UPDATE_CHECK_MS);
    // A build id seen before registration landed was skipped; check it now.
    updater.onServerBuild(getServerBuild());
  },
});
