import { registerSW } from "virtual:pwa-register";

import { createUpdater } from "./pwa-update";
import { getServerBuild, subscribeServerBuild } from "./server-build";

// Service-worker registration + update wiring, in one place so the `virtual:pwa-register` import
// (a build-time virtual module) stays isolated and easy to stub in tests. The update logic itself
// lives in lib/pwa-update.ts.

// How often an open tab re-checks for a newer service worker. Frequent enough to feel automatic,
// cheap enough to ignore (a conditional GET of sw.js that 304s when nothing changed).
const UPDATE_CHECK_MS = 60_000;

let registration: ServiceWorkerRegistration | undefined;

const updater = createUpdater({
  appBuild: __BUILD_INFO__.id,
  registration: () => registration,
  reload: () => window.location.reload(),
  unregisterAll: async () => {
    const all = await navigator.serviceWorker.getRegistrations();
    await Promise.all(all.map((r) => r.unregister()));
  },
  storage: () => window.sessionStorage,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  hadController: "serviceWorker" in navigator && Boolean(navigator.serviceWorker.controller),
});

/** Check for a newer worker now (the 60s poll does this on its own). */
export const checkForUpdate = () => updater.checkForUpdate();

// A rebuild shows up first as a new `X-Sightr-Build` on the next poll or SSE event.
subscribeServerBuild(() => updater.onServerBuild(getServerBuild()));

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, r) {
    registration = r;
    if (!r) return;
    r.addEventListener("updatefound", () => updater.watchWorker(r.installing));
    navigator.serviceWorker?.addEventListener("controllerchange", updater.onControllerChange);
    setInterval(() => void r.update().catch(() => {}), UPDATE_CHECK_MS);
    // A header seen before registration landed was skipped; check it now.
    updater.onServerBuild(getServerBuild());
  },
});
