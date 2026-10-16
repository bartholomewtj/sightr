import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

import { __resetConnTelemetry } from "@v1/lib/conn-telemetry";

import { __resetToasts } from "@/components/toast";
import { __resetThreadUndoNotice } from "@/hooks/showThreadUndoNotice";
import { clearLockRequired } from "@/lib/lock";
import { __resetSidebarState } from "@/state/sidebar";
import { __resetShellStream } from "@/stream/shell-stream";
import { __resetStreamStores } from "@/stream/stores";
import { __resetThreadStream } from "@/stream/thread-stream";
import { __resetUiState } from "@/uiStateStore";

import { FakeEventSource } from "./fake-event-source";
import { installMatchMedia, resetMedia } from "./media";

/** Default bridge: no lock, telemetry accepted. Tests add `server.use(...)` per case. */
export const handlers = [
  http.get("/api/lock", () => HttpResponse.json({ enabled: false, unlocked: true })),
  http.post("/api/conn", () => new HttpResponse(null, { status: 204 })),
];

export const server = setupServer(...handlers);

// jsdom has neither EventSource nor a working matchMedia.
Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: FakeEventSource });
installMatchMedia();
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
window.scrollTo = () => {};

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
  __resetConnTelemetry();
  __resetShellStream();
  __resetThreadStream();
  __resetStreamStores();
  __resetUiState();
  __resetSidebarState();
  __resetToasts();
  __resetThreadUndoNotice();
  clearLockRequired();
  FakeEventSource.reset();
  resetMedia();
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
