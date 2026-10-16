/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { clientsClaim } from "workbox-core";

import { decidePush, type PushPayload } from "@v1/lib/push-decision";

// The v2 service worker, scope /v2/. Precaches the web2 shell, answers /v2/ navigations with the
// cached /v2/index.html, and renders the bridge's push notifications. The push handlers are copied
// from web/src/sw.ts; the deep link is /v2/pane/:paneId, which the app resolves to a thread.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

precacheAndRoute(self.__WB_MANIFEST);
// The API and the reserved proxy namespace never come from the precache (web/src/lib/sw-routes.ts).
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/v2/index.html"), {
    denylist: [/^\/api\//, /^\/auth(?:[/?]|$)/, /^\/cdn-cgi\//],
  }),
);

self.addEventListener("install", () => void self.skipWaiting());
clientsClaim();
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
});

// ── Web Push ────────────────────────────────────────────────────────────────────────────────────
const ICON = "/v2/web-app-manifest-192x192.png";

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
  const path = paneId && paneId !== "test" ? `/v2/pane/${encodeURIComponent(paneId)}` : "/v2/";
  event.waitUntil(openPath(path));
});

async function openPath(path: string): Promise<void> {
  const url = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (!new URL(client.url).pathname.startsWith("/v2")) continue; // leave v1 tabs alone
    await client.focus();
    if (client.url !== url) await client.navigate(url).catch(() => null);
    return;
  }
  await self.clients.openWindow(url);
}
