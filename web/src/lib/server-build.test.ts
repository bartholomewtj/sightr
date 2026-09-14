import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { server } from "../test/setup";
import { fixtureSnapshot } from "../test/handlers";

// The store is module state with no reset hook, so every case gets a fresh copy of the module.
// lib/api.ts is re-imported alongside it so the header capture lands in the same instance.
let sb: typeof import("./server-build");
let api: typeof import("./api");

beforeEach(async () => {
  vi.resetModules();
  sb = await import("./server-build");
  api = await import("./api");
});

describe("observeServerBuild — store semantics", () => {
  it("records a real id, and an absent header (null) is a no-op that never clobbers", () => {
    expect(sb.getServerBuild()).toBeUndefined();
    sb.observeServerBuild("0.13.0+abc.1");
    expect(sb.getServerBuild()).toBe("0.13.0+abc.1");
    sb.observeServerBuild(null); // older bridge — no X-Sightr-Build header
    expect(sb.getServerBuild()).toBe("0.13.0+abc.1"); // left as-is, not reset to undefined
  });

  it("notifies subscribers on EVERY observation, repeats included (hysteresis depends on it)", () => {
    let hits = 0;
    const unsub = sb.subscribeServerBuild(() => hits++);
    sb.observeServerBuild("a");
    sb.observeServerBuild("a"); // a repeat still fires — the store records every observation
    sb.observeServerBuild("b");
    sb.observeServerBuild(null); // absent header does not fire
    expect(hits).toBe(3);
    unsub();
  });
});

describe("header capture through the api fetch wrapper (MSW exposes the response header)", () => {
  it("captures X-Sightr-Build off a snapshot poll", async () => {
    server.use(
      http.get("/api/snapshot", () =>
        HttpResponse.json(fixtureSnapshot, { headers: { "x-sightr-build": "0.13.0+srv.9" } }),
      ),
    );
    await api.fetchSnapshot();
    expect(sb.getServerBuild()).toBe("0.13.0+srv.9");
  });

  it("captures the header off a pane poll too", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () =>
        HttpResponse.json(
          { paneId: "w1:p1", text: "x", truncated: false, revision: 1 },
          { headers: { "x-sightr-build": "0.13.0+pane.3" } },
        ),
      ),
    );
    await api.fetchPane("w1:p1");
    expect(sb.getServerBuild()).toBe("0.13.0+pane.3");
  });

  it("leaves the store undefined when the bridge sends no header (graceful older-bridge fallback)", async () => {
    await api.fetchSnapshot(); // default handler sets no x-sightr-build header
    expect(sb.getServerBuild()).toBeUndefined();
  });
});

describe("useServerBuild — reactive read", () => {
  it("re-renders when a new id is observed", () => {
    const { result } = renderHook(() => sb.useServerBuild());
    expect(result.current).toBeUndefined();
    act(() => sb.observeServerBuild("v2"));
    expect(result.current).toBe("v2");
  });
});
