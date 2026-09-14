import { registerSW } from "virtual:pwa-register";

// Service-worker registration + update wiring, in one place so the `virtual:pwa-register` import
// (a build-time virtual module) stays isolated and easy to stub in tests.
//
// Watch the service-worker lifecycle and reload when a new worker activates. Periodic checks keep
// an open tab current, while checkForUpdate() can force an immediate check.

// How often an open tab re-checks for a newer service worker. Frequent enough to feel automatic,
// cheap enough to ignore (a conditional GET of sw.js that 304s when nothing changed).
const UPDATE_CHECK_MS = 60_000;

// Hard cap so the manual button can never get stuck on "updating…": if no worker has activated by
// now, reload anyway (served by whatever SW is active). The activated-watcher below almost always
// fires first (install+activate is usually 1–2s); this is pure insurance.

const defaultReload = () => window.location.reload();
let registration: ServiceWorkerRegistration | undefined;
let reloaded = false;
let reloadImpl: () => void = defaultReload;

// Was a service worker already controlling this page when we loaded? On a first-ever visit it
// isn't: `immediate` registration + the SW's clientsClaim then fire ONE `controllerchange` that is
// *initial* control, not an update — reloading on it is the spurious first-load flash. We ignore
// that first event (and mark ourselves controlled from then on), so only a *subsequent*
// controllerchange — a new SW replacing the old one — reloads. On a return visit a controller
// already exists, so every change reloads.
let hadController = "serviceWorker" in navigator && Boolean(navigator.serviceWorker.controller);

function requestReload(action: () => void): void {
  if (reloaded) return;
  reloaded = true;
  action();
}

function reloadOnce() {
  requestReload(reloadImpl);
}

// Last-resort reload that BYPASSES a wedged service worker: unregister every registration first, so
// the ensuing navigation fetches straight from the bridge instead of being answered from the stale
// precache (a plain reload stays controlled by the active worker and would re-serve the SAME old
// bundle — the "keeps saying new build, won't update" trap). The SW re-registers clean on the fresh
// load. Used ONLY when the normal worker-swap didn't confirm a newly-activated worker — never on the
// happy path, where the new precache is already in place and reloadOnce() is correct and lighter.
function onControllerChange() {
  if (hadController) reloadOnce();
  else hadController = true;
}

// Reload as soon as a freshly-installed worker reaches "activated". Used by both the periodic
// auto-check and the manual button, so neither depends on vite-plugin-pwa's (unreliable) auto-reload.
function watchWorker(worker: ServiceWorker | null) {
  if (!worker) return;
  if (worker.state === "activated") {
    reloadOnce();
    return;
  }
  worker.addEventListener("statechange", () => {
    // skipWaiting is set in the generated SW, but if a worker still parks in "installed" (waiting),
    // nudge it through so it activates instead of stranding us.
    if (worker.state === "installed") registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
    if (worker.state === "activated") reloadOnce();
  });
}



registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, r) {
    registration = r;
    if (!r) return;
    // Any newly-found worker (from the poll below or a manual check) → reload when it activates.
    r.addEventListener("updatefound", () => watchWorker(r.installing));
    // A new SW taking control is the other reliable "we're updated now" signal — but only when it
    // *replaces* a prior controller (see onControllerChange); the first-visit initial claim is not
    // an update and must not reload.
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);
    setInterval(() => void r.update().catch(() => {}), UPDATE_CHECK_MS);
  },
});

// Force an immediate service-worker update check. A newer SW installs,
// skip-waits, activates, and watchWorker reloads us onto it (the happy path). The ONE path that
// forceReload()s — unregistering the worker so the reload bypasses a stale precache — is when
// update() SUCCEEDS (so we're online) but finds nothing to activate while the active worker is stale:
// the wedged-precache trap. Network-failure paths (a thrown update(), or the stuck-guard) fall back to
// a PLAIN reload instead — unregistering there would strand an offline PWA on an error page with its
// precache gone. With no SW at all (plain HTTP / insecure context) a plain reload already re-fetches.
