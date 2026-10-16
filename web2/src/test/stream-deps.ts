import { vi } from "vitest";

import type { ConnectionDeps } from "@/stream/connection";

import { FakeEventSourceCtor } from "./fake-event-source";

/**
 * Connection deps for tests: the fake EventSource, the (fake-timer) clock, a fixed `random` (0.5 means
 * no jitter), and a probe `fetch` that by default fails like an unreachable bridge.
 */
export function testDeps(over: Partial<ConnectionDeps> = {}): ConnectionDeps & { fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  return {
    EventSource: FakeEventSourceCtor,
    fetch,
    now: () => Date.now(),
    random: () => 0.5,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    document,
    ...over,
  } as ConnectionDeps & { fetch: ReturnType<typeof vi.fn> };
}

export function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

export function blockingResponse(code = "herdr-too-old"): Response {
  return new Response(
    JSON.stringify({ ok: false, code, error: "v2 needs herdr >= 0.9.0 (found 0.8.2)", have: "0.8.2", need: "0.9.0" }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}
