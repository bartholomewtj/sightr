import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { setDesktop, __resetDesktop } from "@/lib/desktop";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { render, cleanup, waitFor, screen, act } from "@testing-library/react";
import { RootLayout, BootSplash, shownLastSeenAt } from "./root";
import { createMemoryRouter, RouterProvider } from "react-router";
import { MARK_SRC } from "@/components/sightr-mark";
import { CONNECTION_LOST_MS } from "@/hooks/use-connection-lost";
import { __resetConnectionHealth } from "@/lib/connection-health";

vi.mock("@/hooks/use-polling", () => ({ usePolling: vi.fn() }));
vi.mock("@/hooks/use-transitions", () => ({ useAgentTransitions: vi.fn() }));
vi.mock("@/hooks/use-push", () => ({ usePushSetup: vi.fn(), usePushDevice: vi.fn(() => ({ seen: false, readOnly: false })) }));
vi.mock("@/hooks/use-poll-busy", () => ({ usePollBusy: vi.fn() }));
vi.mock("@/components/connection-banner", () => ({ ConnectionBanner: () => null }));

// BootSplash is the router's HydrateFallback: it stays mounted until the FIRST loader run settles, so
// over a dead tailnet (a hanging initial fetch) it can otherwise gallop the dog forever with no way
// out. It must escalate to an actionable "Not connected" state once stuck past CONNECTION_LOST_MS.
// Fake timers drive the wall-clock hook (Vitest advances Date.now with them).
describe("BootSplash — escalates a stuck cold start", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth(); // module-load anchor == frozen clock: a dead cold start escalates ~15s in
  });
  afterEach(() => vi.useRealTimers());

  it("shows the connecting splash before the threshold", () => {
    const { container } = render(<BootSplash />);
    expect(screen.getByText("Connecting to the herd…")).toBeInTheDocument();
    expect(container.querySelector('img[src="/sightr-loading-badge.svg"]')).not.toBeNull();
    // still the plain splash a beat before the threshold
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 1));
    expect(screen.getByText("Connecting to the herd…")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
  });

  it("escalates to 'Not connected' with a Retry once stuck past the threshold", () => {
    const { container } = render(<BootSplash />);
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(screen.queryByText("Connecting to the herd…")).not.toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(/Can.t reach Sightr/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // The running loader is gone — rest state is the muted static badge.
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
    expect(container.querySelector(".sightr-mark")).toBeNull();
    const icon = container.querySelector(`img[src="${MARK_SRC}"]`);
    expect(icon).not.toBeNull();
    expect(icon?.closest("span")?.className ?? "").toMatch(/grayscale/);
  });
});

const NOON = new Date(2026, 0, 2, 12, 5).getTime();
const AFTERNOON = new Date(2026, 0, 2, 14, 32).getTime();

function home(lastSeenAt?: number): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    error: true,
    authError: false,
    lastSeenAt,
  };
}

function pane(overrides: Partial<PaneData>): PaneData {
  return {
    paneId: "w1:p1",
    text: "old terminal text",
    truncated: false,
    requestedLines: 600,
    revision: 0,
    error: true,
    authError: false,
    ...overrides,
  };
}

describe("which 'last seen' the connection bar shows", () => {
  it("uses the snapshot's stamp on the dashboard (no pane route active)", () => {
    expect(shownLastSeenAt(home(AFTERNOON), undefined)).toBe(AFTERNOON);
  });

  it("uses the PANE's own stamp while a stale mirror is what's being read", () => {
    expect(shownLastSeenAt(home(AFTERNOON), pane({ lastSeenAt: NOON }))).toBe(NOON);
  });

  it("says nothing rather than borrowing the herd's stamp for an undatable mirror", () => {
    expect(shownLastSeenAt(home(AFTERNOON), pane({ lastSeenAt: undefined }))).toBeUndefined();
  });

  it("falls back to the snapshot when the stale pane has no text to date", () => {
    expect(shownLastSeenAt(home(AFTERNOON), pane({ text: "", lastSeenAt: undefined }))).toBe(
      AFTERNOON,
    );
  });

  it("falls back to the snapshot when the pane itself is live", () => {
    expect(shownLastSeenAt(home(AFTERNOON), pane({ error: false, lastSeenAt: NOON }))).toBe(
      AFTERNOON,
    );
  });
});

// Folded from root-scroll.test.tsx.
describe('root desktop frame', () => {
  const data = { bridge: "connected" as const, device: undefined, agents: [], shellPanes: [], workspaces: [], tabs: [], error: false, authError: false, files: false };
  beforeEach(() => __resetDesktop()); afterEach(() => __resetDesktop());
  function show() { const router = createMemoryRouter([{ id: "root", path: "/", loader: () => data, element: <RootLayout />, children: [{ index: true, element: <div>outlet</div> }] }], { initialEntries: ["/"] }); return render(<RouterProvider router={router} />); }
  describe("root desktop frame", () => {
    it("keeps the phone root class unchanged", async () => { const view = show(); await screen.findByText("outlet"); expect(view.container.firstElementChild).toHaveClass("flex", "h-[100dvh]", "flex-col"); expect(view.container.firstElementChild).not.toHaveClass("overflow-hidden"); });
    it("clips the desktop root", async () => { setDesktop(true); const view = show(); await screen.findByRole("navigation", { name: "Desktop navigation" }); expect(view.container.firstElementChild).toHaveClass("overflow-hidden"); });
  });
});

// Folded from root-title.test.tsx.
describe('desktop document title', () => {
  function data(agents: HomeData["agents"] = []) { return { bridge: "connected", device: undefined, agents, shellPanes: [], workspaces: [], tabs: [], error: false, authError: false, files: false } as HomeData; }
  function agent(paneId: string) { return { paneId, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status: "blocked" as const, cwd: "/tmp", focused: false }; }
  function show(home = data()) { const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => home, element: <RootLayout />, children: [{ index: true, element: <div /> }] }]); return render(<RouterProvider router={router} />); }
  afterEach(() => { cleanup(); __resetDesktop(); });
  describe("desktop document title", () => {
    it("leaves title alone when off", async () => { document.title = "Existing"; show(); await waitFor(() => expect(document.title).toBe("Existing")); });
    it("counts needs agents when on", async () => { setDesktop(true); show(data([agent("a"), agent("b")])); await waitFor(() => expect(document.title).toBe("(2) Sightr")); });
    it("uses the plain title on desktop with no needs agents", async () => { setDesktop(true); document.title = "Existing"; show(data([])); await waitFor(() => expect(document.title).toBe("Sightr")); });
  });
});