import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import type { ReactElement } from "react";

import { AppHeader } from "./app-header";
import { MARK_SRC } from "./sightr-mark";
import { StatusBadge } from "./status-badge";
import { CONNECTION_LOST_MS, TROUBLE_MS } from "@/hooks/use-connection-lost";
import { __resetConnectionHealth } from "@/lib/connection-health";

// AppHeader mounts SightrHome (a button) and, via SettingsGear, useNavigate — so it needs a router.
function renderHeader(ui: ReactElement) {
  return render(ui, { wrapper: MemoryRouter });
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

describe("AppHeader — the one shared header shell", () => {
  beforeEach(() => __resetConnectionHealth());

  it("is calm in the PANE variant while live — breadcrumb + status badge, no pill, no wordmark", () => {
    // Connection copy lives in the top ConnectionBanner now; the header carries none. A healthy pane
    // header shows its own bits and a resting (static) Sightr mark.
    const { container } = renderHeader(
      <AppHeader
        bridge="connected"
        error={false}
        rightLead={<StatusBadge status="working" />}
      >
        <span>webapp › main</span>
      </AppHeader>,
    );
    expect(screen.queryByRole("status")).toBeNull(); // no connection pill of any kind
    expect(container.querySelector(".sightr-mark")).toBeNull(); // mark at rest (static icon)
    expect(screen.getByText("webapp › main")).toBeInTheDocument(); // the breadcrumb slot
    expect(screen.getByText("working")).toBeInTheDocument(); // the agent status badge
    expect(screen.queryByText("Sightr")).toBeNull(); // no wordmark in a pane
  });

  it("is calm in the DASHBOARD variant while live — wordmark, resting mark", () => {
    const { container } = renderHeader(
      <AppHeader bridge="connected" error={false} wordmark />,
    );
    expect(screen.getByText("Sightr")).toBeInTheDocument(); // wordmark
    expect(container.querySelector(".sightr-mark")).toBeNull(); // mark at rest while live
  });

  // Spec 22: the header pads the notch through --chrome-top-inset, which is 0 while a connection
  // banner above it owns the top edge. A raw env() here would pad it a second time.
  it("pads the notch through --chrome-top-inset, never a second raw safe-area inset", () => {
    const { container } = renderHeader(<AppHeader bridge="connected" error={false} />);
    const header = container.querySelector("header")!;
    expect(header.className).toContain("var(--chrome-top-inset)");
    expect(header.className).not.toContain("env(safe-area-inset-top)");
  });

  it("goes to Spaces when the Sightr mark is tapped, like the bottom-bar tab", async () => {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <AppHeader bridge="connected" error={false} wordmark />
        <LocationProbe />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sightr home" }));
    expect(screen.getByTestId("loc").textContent).toBe("/");
  });

  it("the find-bar override takes over the whole row (mark and breadcrumb yield)", () => {
    // `error` → not live, so the mark would react — proving the override replaces the row entirely.
    renderHeader(
      <AppHeader
        bridge="connected"
        error
        rightLead={<StatusBadge status="working" />}
        override={<div>FINDBAR</div>}
      >
        <span>webapp › main</span>
      </AppHeader>,
    );
    // The override owns the row while searching — the normal content is replaced, not stacked.
    expect(screen.getByText("FINDBAR")).toBeInTheDocument();
    expect(screen.queryByText("webapp › main")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sightr home" })).toBeNull();
  });
});

// The header dog agrees with the ConnectionBanner by construction — it reads the SAME shared-clock
// signals: it gallops only once trouble is sustained (≥4s, the flicker fix), and rests muted once lost
// (≥15s). Fake timers drive the wall-clock hooks (Vitest advances Date.now with them).
describe("AppHeader — the dog keys on trouble/lost, not the first not-live frame", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth(); // anchor == frozen clock, so the thresholds land exactly
  });
  afterEach(() => vi.useRealTimers());

  it("stays a static icon during a brief not-live spell, gallops at 4s, rests muted at 15s", () => {
    const { container } = renderHeader(<AppHeader bridge="connected" error />);
    // A single not-live frame is NOT trouble yet: the mark stays the static, full-color icon.
    expect(container.querySelector(".sightr-mark")).toBeNull();
    expect(container.querySelector(`img[src="${MARK_SRC}"]`)).not.toBeNull();
    expect(container.querySelector(`img[src="${MARK_SRC}"]`)?.closest("span")?.className ?? "").not.toMatch(
      /grayscale/,
    );

    // Sustained trouble (4s) → the dog gallops (agreeing with the amber bar).
    act(() => vi.advanceTimersByTime(TROUBLE_MS));
    expect(container.querySelector(".sightr-mark")).toHaveClass("sightr-mark--running");

    // Escalated to lost (15s) → the gallop stops and the mark rests on the muted static icon.
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - TROUBLE_MS));
    expect(container.querySelector(".sightr-mark")).toBeNull();
    expect(container.querySelector(`img[src="${MARK_SRC}"]`)?.closest("span")?.className ?? "").toMatch(
      /grayscale/,
    );
  });
});
