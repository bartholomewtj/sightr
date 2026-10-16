/// <reference lib="webworker" />
/// <reference types="vite/client" />
import { precacheAndRoute, createHandlerBoundToURL } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { clientsClaim } from "workbox-core";

import { decidePush, type PushPayload } from "@v1/lib/push-decision";

import { isStaleV1FontEntry, navigationDenylist, V1_FONT_CACHE } from "./lib/sw-routes";

// web2's service worker. Since the T15 cutover it is `/sw.js` with scope `/`, the URL and scope v1's
// worker had, so an installed PWA swaps v1's worker for this one in place: skipWaiting + clientsClaim
// below, and the page reloads on `controllerchange` (lib/pwa.ts). Precaches the web2 shell, answers
// navigations with the cached index.html (never `/v1/`, `/api/`, `/auth`), and renders the bridge's
// push notifications; the deep link is `<base>pane/:paneId`, which the app resolves to a thread.
// `BASE` is vite's `base`: `/` in production, `/v2/` for the dev preview.
const BASE = import.meta.env.BASE_URL;
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

precacheAndRoute(self.__WB_MANIFEST);
// v1's old precache at this scope has the same cache name as ours, so workbox's own activate step
// already drops its entries. No `cleanupOutdatedCaches()`: it deletes every precache whose name
// contains this scope's URL, and v1's at `/v1/` (`workbox-precache-v2-<origin>/v1/`) does.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL(`${BASE}index.html`), {
    denylist: navigationDenylist(BASE),
  }),
);

// v1's lazy font cache held `/fonts/...` entries before the cutover; v1 now loads `/v1/fonts/...`
// and sweeps its own entries. Drop the ones only the old v1 at `/` could use.
self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      if (!(await caches.has(V1_FONT_CACHE))) return;
      const cache = await caches.open(V1_FONT_CACHE);
      for (const req of await cache.keys()) {
        if (isStaleV1FontEntry(new URL(req.url).pathname)) await cache.delete(req);
      }
    })().catch(() => undefined),
  );
});

self.addEventListener("install", () => void self.skipWaiting());
clientsClaim();
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
});

// ── Web Push ────────────────────────────────────────────────────────────────────────────────────
const ICON = `${BASE}web-app-manifest-192x192.png`;

self.addEventListener("push", (event: PushEvent) => {
  event.waitUntil(handlePush(event));
});

async function anyVisibleClient(): Promise<boolean> {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.some((c) => c.visibilityState === "visible");
}

async function handlePush(event: PushEvent): Promise<void> {
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() as PushPayload) ?? {};
  } catch {
    payload = { body: event.data?.text() };
  }

  const decision = decidePush(payload, await anyVisibleClient());
  if (decision.kind === "suppress") return;
  if (decision.kind === "clear") {
    const stale = await self.registration.getNotifications({ tag: decision.tag });
    for (const n of stale) n.close();
    return;
  }
  const options: NotificationOptions & { renotify?: boolean } = {
    body: decision.body,
    data: { paneId: decision.paneId },
    icon: ICON,
    badge: ICON,
    tag: decision.tag,
    renotify: decision.renotify,
  };
  await self.registration.showNotification(decision.title, options);
}

interface NotifData {
  paneId?: string;
}

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = (event.notification.data as NotifData | null) ?? {};
  const paneId = data.paneId;
  const path = paneId && paneId !== "test" ? `${BASE}pane/${encodeURIComponent(paneId)}` : BASE;
  event.waitUntil(openPath(path));
});

async function openPath(path: string): Promise<void> {
  const url = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).pathname.startsWith("/v1/")) continue; // leave v1 tabs alone
    await client.focus();
    if (client.url !== url) await client.navigate(url).catch(() => null);
    return;
  }
  await self.clients.openWindow(url);
}
