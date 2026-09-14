import { act, renderHook } from "@testing-library/react";

import { canGoBack, useBack } from "./use-back";

const nav = vi.hoisted(() => ({ go: vi.fn() }));
vi.mock("react-router", () => ({
  useNavigate: () => nav.go,
}));

describe("canGoBack", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is false on a boot entry (idx 0) and true once something is behind it", () => {
    vi.stubGlobal("history", { state: { idx: 0 } });
    expect(canGoBack()).toBe(false);
    vi.stubGlobal("history", { state: { idx: 1 } });
    expect(canGoBack()).toBe(true);
    vi.stubGlobal("history", { state: null });
    expect(canGoBack()).toBe(false);
  });
});

describe("useBack", () => {
  beforeEach(() => nav.go.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  it("pops when React Router has an entry behind this one", () => {
    vi.stubGlobal("history", { state: { idx: 1 } });
    const { result } = renderHook(() => useBack("/files"));
    act(() => result.current());
    expect(nav.go).toHaveBeenCalledWith(-1);
  });

  it("replaces with the fallback on a boot entry so the header cannot ping-pong", () => {
    vi.stubGlobal("history", { state: { idx: 0 } });
    const { result } = renderHook(() => useBack("/files"));
    act(() => result.current());
    expect(nav.go).toHaveBeenCalledWith("/files", { replace: true });
  });
});
