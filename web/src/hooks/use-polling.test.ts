import { act, renderHook } from "@testing-library/react";

const push = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  openSnapshotStream: push.open,
  fetchSnapshot: vi.fn(),
}));

import { SSE_RETRY_MAX_MS, SSE_STABLE_MS, SSE_STALE_MS, SUPERSEDE_MS, intervalFor, usePolling } from "./use-polling";
import { rootLoader, setSnapshotPushMode } from "@/lib/loaders";
import type { HomeData } from "@/lib/loaders";
import type { AgentView } from "@/lib/types";

// usePolling reads useRevalidator(); drive its state/revalidate directly (hoisted so the vi.mock
// factory can close over the holder). intervalFor is pure and doesn't touch it.
const rr = vi.hoisted(() => ({ state: "idle" as "idle" | "loading", revalidate: vi.fn() }));
vi.mock("react-router", () => ({
  useRevalidator: () => ({ state: rr.state, revalidate: rr.revalidate }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(paneId: string, status: AgentView["status"]): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "test",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status,
    cwd: "/",
    focused: false,
  };
}

function makeShell(paneId: string): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "test",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "shell",
    status: "unknown",
    cwd: "/",
    focused: false,
    kind: "shell",
  };
}

function makeData(agents: AgentView[], shellPanes: AgentView[] = []): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents,
    shellPanes,
    workspaces: [],
    tabs: [],
    error: false,
    authError: false,
  };
}

const HOT = 1500;
const COLD = 4000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("intervalFor", () => {
  it("returns COLD when data is undefined and no pane is open", () => {
    expect(intervalFor(undefined)).toBe(COLD);
  });

  it("returns COLD when the herd is idle and no pane is open", () => {
    const data = makeData([makeAgent("w1:p1", "idle"), makeAgent("w1:p2", "done")]);
    expect(intervalFor(data)).toBe(COLD);
  });

  it("returns COLD when the herd is idle and no paneId is provided (home screen)", () => {
    const data = makeData([makeAgent("w1:p1", "idle")]);
    expect(intervalFor(data, null)).toBe(COLD);
  });

  it("returns HOT when any agent in the herd is working", () => {
    const data = makeData([makeAgent("w1:p1", "idle"), makeAgent("w1:p2", "working")]);
    expect(intervalFor(data)).toBe(HOT);
  });

  it("returns HOT when any agent in the herd is blocked", () => {
    const data = makeData([makeAgent("w1:p1", "blocked"), makeAgent("w1:p2", "done")]);
    expect(intervalFor(data)).toBe(HOT);
  });

  it("returns HOT when herd is idle but the open pane is an agent pane that is working", () => {
    // The open agent is idle globally but let's test: open pane exists in agents → HOT.
    // More precisely: the rule is "pane exists in agents ∪ shellPanes" → HOT regardless of status.
    const data = makeData([makeAgent("w1:p1", "idle")]);
    expect(intervalFor(data, "w1:p1")).toBe(HOT);
  });

  it("returns HOT when the open pane is a shell (shells are always live when open)", () => {
    const data = makeData([], [makeShell("w1:s1")]);
    expect(intervalFor(data, "w1:s1")).toBe(HOT);
  });

  it("returns COLD when a paneId is given but it matches no pane in agents or shellPanes", () => {
    const data = makeData([makeAgent("w1:p1", "idle")], [makeShell("w1:s1")]);
    expect(intervalFor(data, "w99:phantom")).toBe(COLD);
  });

  it("returns HOT (from herd) even when paneId is absent", () => {
    const data = makeData([makeAgent("w1:p1", "working")]);
    expect(intervalFor(data, undefined)).toBe(HOT);
  });
});

// The self-heal: a revalidation wedged in "loading" (a black-holed fetch) would otherwise no-op
// every future tick, since the fast-path only revalidates while idle. Once it has been loading past
// SUPERSEDE_MS, a tick kicks a fresh revalidate() to supersede the hung one.
describe("usePolling — SSE mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rr.state = "idle";
    rr.revalidate.mockClear();
    push.open.mockImplementation(() => ({
      addEventListener: vi.fn((name: string, fn: () => void) => { if (name === "open") fn(); }),
      close: vi.fn(),
    }));
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: function EventSource() {} });
  });
  afterEach(() => { setSnapshotPushMode(false); vi.useRealTimers(); Reflect.deleteProperty(globalThis, "EventSource"); });

  it("stops snapshot polling on a connected home stream", () => {
    renderHook(() => usePolling(makeData([makeAgent("w1:p1", "idle")] )));
    vi.advanceTimersByTime(COLD);
    expect(rr.revalidate).not.toHaveBeenCalled();
  });

  it("keeps pane text polling while the snapshot stream is connected", () => {
    renderHook(() => usePolling(makeData([makeAgent("w1:p1", "idle")]), "w1:p1"));
    vi.advanceTimersByTime(HOT);
    expect(rr.revalidate).toHaveBeenCalled();
  });

  it("revalidates from a pushed snapshot while a pane is open", () => {
    let onSnapshot: ((snapshot: unknown) => void) | undefined;
    push.open.mockImplementation((callback: (snapshot: unknown) => void) => {
      onSnapshot = callback;
      return { addEventListener: vi.fn((name: string, fn: () => void) => { if (name === "open") fn(); }), close: vi.fn() };
    });
    renderHook(() => usePolling(makeData([makeAgent("w1:p1", "idle")]), "w1:p1"));
    rr.revalidate.mockClear();
    act(() => onSnapshot?.({
      bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], ts: 1,
    }));
    expect(rr.revalidate).toHaveBeenCalled();
  });

  it("resumes polling when the stream errors", () => {
    const stream = { addEventListener: vi.fn(), close: vi.fn() };
    push.open.mockReturnValue(stream);
    renderHook(() => usePolling(makeData([makeAgent("w1:p1", "idle")] )));
    const error = stream.addEventListener.mock.calls.find(([name]) => name === "error")?.[1];
    act(() => error?.());
    vi.advanceTimersByTime(COLD);
    expect(rr.revalidate).toHaveBeenCalled();
  });

  // A stream the test drives: `fire` delivers an event the hook listens for; `beat`/`fail` are the
  // callbacks the hook handed openSnapshotStream.
  function liveStreams() {
    const streams: Array<{ close: ReturnType<typeof vi.fn>; beat: () => void; fail: () => void }> = [];
    push.open.mockImplementation((_onSnapshot: unknown, onError: () => void, onBeat: () => void) => {
      const s = { addEventListener: vi.fn((name: string, fn: () => void) => { if (name === "open") fn(); }), close: vi.fn() };
      streams.push({ close: s.close, beat: onBeat, fail: onError });
      return s;
    });
    return streams;
  }

  it("keeps one stream when the open pane changes", () => {
    const streams = liveStreams();
    const { rerender } = renderHook(({ paneId }) => usePolling(makeData([makeAgent("w1:p1", "idle"), makeAgent("w1:p2", "idle")]), paneId), {
      initialProps: { paneId: null as string | null },
    });
    rerender({ paneId: "w1:p1" });
    rerender({ paneId: "w1:p2" });
    rerender({ paneId: null });
    expect(streams.length).toBe(1);
    expect(streams[0]!.close).not.toHaveBeenCalled();
  });

  it("a stream the bridge keeps writing to stays open", () => {
    const streams = liveStreams();
    renderHook(() => usePolling(makeData([makeAgent("w1:p1", "idle")])));
    for (let t = 0; t < 120_000; t += 15_000) {
      act(() => { vi.advanceTimersByTime(15_000); });
      streams[0]!.beat();
    }
    expect(streams.length).toBe(1);
    expect(rr.revalidate).not.toHaveBeenCalled();
  });

  it("a stream that goes silent is dropped, polled past and reopened", () => {
    const streams = liveStreams();
    renderHook(() => usePolling(makeData([makeAgent("w1:p1", "idle")])));
    act(() => { vi.advanceTimersByTime(SSE_STALE_MS - 5_000); });
    expect(streams[0]!.close).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(streams[0]!.close).toHaveBeenCalled();
    expect(rr.revalidate).toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(streams.length).toBe(2);
  });

  it("a stream that keeps dying at once backs off, and one that lived starts over", () => {
    const streams = liveStreams();
    renderHook(() => usePolling(makeData([makeAgent("w1:p1", "idle")])));
    // Opens and dies three times: the reconnects wait 1 s, then 2 s, then 4 s.
    act(() => streams[0]!.fail());
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(streams.length).toBe(2);
    act(() => streams[1]!.fail());
    act(() => { vi.advanceTimersByTime(1_999); });
    expect(streams.length).toBe(2);
    act(() => { vi.advanceTimersByTime(1); });
    expect(streams.length).toBe(3);
    // This one stays up past SSE_STABLE_MS, so its drop reconnects after 1 s again.
    for (let t = 0; t < SSE_STABLE_MS; t += 10_000) {
      act(() => { vi.advanceTimersByTime(10_000); });
      streams[2]!.beat();
    }
    act(() => streams[2]!.fail());
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(streams.length).toBe(4);
  });

  it("reconnects as soon as the network comes back", () => {
    const streams = liveStreams();
    renderHook(() => usePolling(makeData([makeAgent("w1:p1", "idle")])));
    for (let i = 0; i < 5; i++) {
      act(() => streams[streams.length - 1]!.fail());
      act(() => { vi.advanceTimersByTime(SSE_RETRY_MAX_MS); });
    }
    act(() => streams[streams.length - 1]!.fail());
    const before = streams.length;
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(streams.length).toBe(before + 1);
    // An open stream is left alone.
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(streams.length).toBe(before + 1);
  });

  it("a late error from a replaced stream leaves the new one alone", () => {
    const streams = liveStreams();
    renderHook(() => usePolling(makeData([makeAgent("w1:p1", "idle")])));
    act(() => streams[0]!.fail());
    act(() => { vi.advanceTimersByTime(1_000); });
    act(() => streams[0]!.fail());
    expect(streams[1]!.close).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(SSE_RETRY_MAX_MS); });
    expect(streams.length).toBe(2);
  });

  it("renders a pushed snapshot without fetching it again", async () => {
    let onSnapshot: ((snapshot: unknown) => void) | undefined;
    push.open.mockImplementation((callback: (snapshot: unknown) => void) => {
      onSnapshot = callback;
      return { addEventListener: vi.fn((name: string, fn: () => void) => { if (name === "open") fn(); }), close: vi.fn() };
    });
    const { fetchSnapshot } = await import("@/lib/api");
    const fetch = vi.mocked(fetchSnapshot);
    fetch.mockReset();
    const url = "http://localhost/";
    await rootLoader({ request: new Request(url) });
    fetch.mockClear();
    const snap = {
      bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], ts: 1,
    } as const;
    renderHook(() => usePolling(makeData([])));
    act(() => onSnapshot?.(snap));
    const pushed = await rootLoader({ request: new Request(url) });
    expect(pushed.agents).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("usePolling — superseding a wedged revalidation", () => {
  const hotData = () => makeData([makeAgent("w1:p1", "working")]); // HOT → 1500ms tick interval

  beforeEach(() => {
    vi.useFakeTimers();
    rr.state = "idle";
    rr.revalidate.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT revalidate on a tick before SUPERSEDE_MS has elapsed", () => {
    rr.state = "loading"; // stuck loading from the very first render
    renderHook(() => usePolling(hotData()));
    vi.advanceTimersByTime(SUPERSEDE_MS - 1); // several HOT ticks, all still within the grace window
    expect(rr.revalidate).not.toHaveBeenCalled();
  });

  it("DOES revalidate once a load has been stuck past SUPERSEDE_MS", () => {
    rr.state = "loading";
    renderHook(() => usePolling(hotData()));
    vi.advanceTimersByTime(SUPERSEDE_MS); // a tick now sees the load has aged past the threshold
    expect(rr.revalidate).toHaveBeenCalled();
  });

  it("still uses the plain idle fast-path when not loading", () => {
    rr.state = "idle";
    renderHook(() => usePolling(hotData()));
    vi.advanceTimersByTime(1_500); // one HOT tick
    expect(rr.revalidate).toHaveBeenCalled();
  });

  it("keeps polling even when navigator.onLine reports false (the flag can lie — never wedge)", () => {
    rr.state = "idle";
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      renderHook(() => usePolling(hotData()));
      vi.advanceTimersByTime(1_500); // one HOT tick with the flag stuck false
      expect(rr.revalidate).toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, "onLine"); // restore the prototype getter
    }
  });
});
