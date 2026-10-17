import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";

const fetchPaneMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), fetchPane: fetchPaneMock }));

import { MIRROR_COLD_MS, MIRROR_HOT_MS, useMirror } from "./useMirror";

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms).then(() => undefined));

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useMirror", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fetchPaneMock.mockReset();
    fetchPaneMock.mockImplementation(async (paneId: string) => ({ paneId, text: "hello", truncated: false, revision: 1 }));
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("reads at once, then every 4 s when cold", async () => {
    const { result } = renderHook(() => useMirror("p1", { hot: false }));
    await tick(0);
    expect(fetchPaneMock).toHaveBeenCalledTimes(1);
    expect(result.current.text).toBe("hello");
    await tick(MIRROR_COLD_MS - 1);
    expect(fetchPaneMock).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetchPaneMock).toHaveBeenCalledTimes(2);
  });

  it("reads every 1.5 s while hot (typing, or the agent working)", async () => {
    renderHook(() => useMirror("p1", { hot: true, lines: 600 }));
    await tick(0);
    await tick(MIRROR_HOT_MS * 3);
    expect(fetchPaneMock).toHaveBeenCalledTimes(4);
    expect(fetchPaneMock).toHaveBeenLastCalledWith("p1", 600, expect.any(AbortSignal));
  });

  it("makes no read when disabled or with no pane", async () => {
    renderHook(() => useMirror("p1", { hot: true, enabled: false }));
    renderHook(() => useMirror(null, { hot: true }));
    await tick(MIRROR_COLD_MS * 2);
    expect(fetchPaneMock).not.toHaveBeenCalled();
  });

  it("stops while the page is hidden and reads at once when it is shown", async () => {
    renderHook(() => useMirror("p1", { hot: true }));
    await tick(0);
    expect(fetchPaneMock).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    await tick(MIRROR_COLD_MS * 3);
    expect(fetchPaneMock).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await tick(0);
    expect(fetchPaneMock).toHaveBeenCalledTimes(2);
  });

  it("reads at once when the network comes back, but not while hidden", async () => {
    renderHook(() => useMirror("p1", { hot: false }));
    await tick(0);
    expect(fetchPaneMock).toHaveBeenCalledTimes(1);
    act(() => void window.dispatchEvent(new Event("online")));
    await tick(0);
    expect(fetchPaneMock).toHaveBeenCalledTimes(2);
    setVisibility("hidden");
    act(() => void window.dispatchEvent(new Event("online")));
    await tick(0);
    expect(fetchPaneMock).toHaveBeenCalledTimes(2);
  });

  it("aborts the read in flight on unmount and reads no more", async () => {
    let signal: AbortSignal | undefined;
    fetchPaneMock.mockImplementation((_p: string, _l: number, s: AbortSignal) => {
      signal = s;
      return new Promise(() => {});
    });
    const { unmount } = renderHook(() => useMirror("p1", { hot: true }));
    await tick(0);
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    await tick(MIRROR_COLD_MS * 2);
    expect(fetchPaneMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchPane", () => {
  it("keeps the cached text on a 304 and sends the ETag back", async () => {
    let calls = 0;
    const seen: (string | null)[] = [];
    server.use(
      http.get("/api/pane/:id", ({ request }) => {
        calls += 1;
        seen.push(request.headers.get("if-none-match"));
        if (calls === 1) return HttpResponse.json({ paneId: "p1", text: "first", truncated: false, revision: 1 }, { headers: { etag: '"r1"' } });
        return new HttpResponse(null, { status: 304 });
      }),
    );
    const { fetchPane: realFetchPane } = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
    expect((await realFetchPane("p1")).text).toBe("first");
    const again = await realFetchPane("p1");
    expect(again.text).toBe("first");
    expect(again.notModified).toBe(true);
    expect(seen).toEqual([null, '"r1"']);
  });
});
