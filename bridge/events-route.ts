import { guard } from "./access.ts";
import type { SnapshotDeps } from "./snapshot-route.ts";
import { snapshotRoute } from "./snapshot-route.ts";
import { buildId } from "./static-assets.ts";

export const EVENT_COALESCE_MS = 250;
export const EVENT_KEEPALIVE_MS = 15_000;

type TimerApi = {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (id: ReturnType<typeof setInterval>) => void;
};

type Client = { id: string; send: (chunk: string) => void; close: () => void; lastSent: number; render?: () => Promise<string> };

/** Fan-out for snapshot SSE streams. State mutations call notify; the state engine calls update. */
export function createSnapshotEvents(
  snapshot: () => Promise<string>,
  now: () => number = Date.now,
  timers: TimerApi = { setTimeout, clearTimeout, setInterval, clearInterval },
) {
  const clients = new Set<Client>();
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;

  const emit = async () => {
    if (!clients.size) return;
    const builtId = buildId();
    let shared: Promise<string> | undefined;
    let built: string | undefined;
    for (const client of [...clients]) {
      const body = await (client.render?.() ?? (shared ??= snapshot()));
      client.send(`event: snapshot\ndata: ${body}\n\n`);
      client.lastSent = now();
      built ??= JSON.stringify(await builtId);
      client.send(`event: build\ndata: ${built}\n\n`);
    }
  };
  const notify = () => {
    if (coalesceTimer !== undefined) return;
    coalesceTimer = timers.setTimeout(() => {
      coalesceTimer = undefined;
      void emit();
    }, EVENT_COALESCE_MS);
  };
  const attach = (client: Omit<Client, "lastSent" | "id">, id = "") => {
    if (id) for (const old of [...clients]) {
      if (old.id === id) { old.close(); clients.delete(old); }
    }
    const full = { ...client, id, lastSent: now() };
    clients.add(full);
    return () => { clients.delete(full); };
  };
  const keepAlive = timers.setInterval(() => {
    const at = now();
    for (const client of [...clients]) {
      if (at - client.lastSent >= EVENT_KEEPALIVE_MS) {
        client.send(": keep-alive\n\n"); client.lastSent = at;
        // A quiet herd still needs a live snapshot so the client stamps connection health.
        void emit();
      }
    }
  }, EVENT_KEEPALIVE_MS);
  return {
    notify,
    update: notify,
    attach,
    close() { timers.clearInterval(keepAlive); if (coalesceTimer !== undefined) timers.clearTimeout(coalesceTimer); },
    clientCount() { return clients.size; },
  };
}

export type SnapshotEvents = ReturnType<typeof createSnapshotEvents>;

/** True when device authentication can make a live snapshot differ per client. */
export function needsPerClientRender(cfg: Pick<import("./config.ts").Config, "deviceHeader">): boolean {
  return cfg.deviceHeader.trim() !== "";
}

export function eventsRoute(
  req: Request,
  deps: SnapshotDeps,
  events: SnapshotEvents,
): Response {
  const denied = guard(req, deps.cfg, "read");
  if (denied) return denied;
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let detach: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      const send = (chunk: string) => { try { controller.enqueue(encoder.encode(chunk)); } catch { /* closed */ } };
      const render = async () => {
        const headers = new Headers();
        req.headers.forEach((value, name) => { if (name !== "accept-encoding") headers.set(name, value); });
        const response = await snapshotRoute(new Request(req, { headers }), deps);
        return response.text();
      };
      detach = events.attach({ send, close: () => { try { controller.close(); } catch {} }, ...(needsPerClientRender(deps.cfg) ? { render } : {}) }, urlClient(req));
      void (async () => {
        const headers = new Headers();
        req.headers.forEach((value, name) => { if (name !== "accept-encoding") headers.set(name, value); });
        const body = await snapshotRoute(new Request(req, { headers }), deps);
        if (!body.ok) { try { controller.error(); } catch {} ; return; }
        send(`event: snapshot\ndata: ${await body.text()}\n\n`);
        send(`event: build\ndata: ${JSON.stringify(await buildId())}\n\n`);
      })();
    },
    cancel() { detach?.(); detach = undefined; },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive", "x-accel-buffering": "no" } });
}

function urlClient(req: Request): string {
  return new URL(req.url).searchParams.get("client")?.trim() ?? "";
}
