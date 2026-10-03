import { CONN_MAX_BODY_BYTES, CONN_MAX_EVENTS, normalizePhoneEvent } from "../shared/conn.ts";
import { deviceAuth, guard } from "./access.ts";
import type { Config } from "./config.ts";
import type { ConnLog } from "./conn-log.ts";
import { requireJsonBody, secure, text } from "./responses.ts";

const accepted = () => secure(new Response(null, { status: 204, headers: { "cache-control": "no-store" } }));

/**
 * POST /api/conn — a batch of the phone's connection telemetry. Read level: it touches no terminal
 * and any device that can watch the herd has a connection worth measuring. The JSON content type
 * keeps it out of reach of a cross-site form post (a JSON POST needs a CORS preflight the bridge
 * never grants). Bounded by body size and event count; invalid events are dropped one by one.
 */
export async function connRoute(req: Request, cfg: Config, conn: ConnLog): Promise<Response> {
  if (req.method !== "POST") return text("method not allowed", 405);
  const denied = guard(req, cfg, "read");
  if (denied) return denied;
  const notJson = requireJsonBody(req);
  if (notJson) return notJson;
  // Off: accept and discard, so a phone with a newer bundle does not keep a backlog it can't send.
  if (!conn.enabled()) return accepted();

  const body = await req.text();
  if (body.length > CONN_MAX_BODY_BYTES) return text("too large", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return text("bad json", 400);
  }
  const events = (parsed as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return text("expected {events: []}", 400);

  const device = deviceAuth(req, cfg).device;
  for (const raw of events.slice(0, CONN_MAX_EVENTS)) {
    const event = normalizePhoneEvent(raw);
    if (event) conn.phone(event, device);
  }
  return accepted();
}
