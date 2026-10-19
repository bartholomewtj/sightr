import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeEventSource } from "@/test/fake-event-source";
import { shellSnapshot } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));

beforeEach(() => {
  server.use(
    http.get("/api/notifications/prefs", () => HttpResponse.json({ blocked: true, done: false })),
    http.get("/api/settings", () =>
      HttpResponse.json({ deviceAllowlist: ["phone"], notifyDelayMs: 30_000, submitKeys: ["Enter"], readLines: 200 }),
    ),
    http.head("/sw.js", () => new HttpResponse(null)),
  );
});

async function open(device?: { enforced: boolean; device: string | null; authorized: boolean }) {
  renderApp("/v2/settings");
  await screen.findByRole("heading", { name: "Settings", level: 1 });
  await waitFor(() => expect(shellSource()).toBeDefined());
  frame(() => shellSource()!.emit("snapshot", { ...shellSnapshot(1), ...(device ? { device } : {}) }));
}

const sectionTitles = () => screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
const openAdvanced = () => fireEvent.click(screen.getByRole("button", { name: /^Advanced/ }));

describe("/settings", () => {
  it("shows the sections in order; Bridge, Connection, Shortcuts and v1 sit folded under Advanced", async () => {
    setViewportWidth(1280);
    await open();
    expect(sectionTitles()).toEqual(["Display", "Composer", "Gesture wheel", "New threads", "Notifications", "Run snapshots", "Security", "About"]);
    expect(screen.queryByRole("region", { name: "Bridge" })).toBeNull();
    openAdvanced();
    await screen.findByRole("region", { name: "Bridge" });
    expect(sectionTitles()).toEqual(["Display", "Composer", "Gesture wheel", "New threads", "Notifications", "Run snapshots", "Security", "Bridge", "Connection", "Shortcuts", "Sightr v1", "About"]);
    fireEvent.click(screen.getByRole("button", { name: "Show shortcuts" }));
    expect(await screen.findByRole("table", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("has no Shortcuts section on a phone, and no desktop-mode control anywhere", async () => {
    setViewportWidth(400);
    await open();
    openAdvanced();
    await screen.findByRole("region", { name: "Bridge" });
    expect(sectionTitles()).not.toContain("Shortcuts");
    expect(screen.queryByText(/desktop mode/i)).toBeNull();
  });

  it("links to Sightr v1 at /v1/, and back to the threads", async () => {
    await open();
    openAdvanced();
    const v1 = within(screen.getByRole("region", { name: "Sightr v1" })).getByRole("link", { name: /Open Sightr v1/ });
    expect(v1).toHaveAttribute("href", "/v1/");
    expect(screen.getByRole("link", { name: "Back to threads" })).toHaveAttribute("href", expect.stringMatching(/^\/v2\/?$/));
  });

  it("read-only: every section shows, the bridge-side controls are disabled", async () => {
    await open({ enforced: true, device: "tablet", authorized: false });
    openAdvanced();
    const bridge = screen.getByRole("region", { name: "Bridge" });
    await waitFor(() => expect(within(bridge).getByLabelText("Read lines")).toHaveValue(200));
    expect(within(bridge).getByLabelText("Read lines")).toBeDisabled();
    expect(within(bridge).getByRole("button", { name: "Save" })).toBeDisabled();
    const notifications = screen.getByRole("region", { name: "Notifications" });
    await waitFor(() => expect(within(notifications).getByRole("switch", { name: "Needs input" })).toBeChecked());
    expect(within(notifications).getByRole("switch", { name: "Needs input" })).toHaveAttribute("aria-disabled", "true");
    expect(within(screen.getByRole("region", { name: "Connection" })).getByText("Read-only · tablet")).toBeInTheDocument();
    // Per-device settings still change.
    const display = screen.getByRole("region", { name: "Display" });
    fireEvent.click(within(display).getByRole("radio", { name: "Light" }));
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("section chips: one per section, a tap opens Advanced and scrolls to it", async () => {
    setViewportWidth(360);
    await open();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Display",
      "Composer",
      "New threads",
      "Notifications",
      "Security",
      "Advanced",
      "About",
    ]);
    expect(screen.queryByRole("region", { name: "Bridge" })).toBeNull();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    fireEvent.click(within(nav).getByRole("link", { name: "Advanced" }));
    await screen.findByRole("region", { name: "Bridge" });
    expect(within(nav).getByRole("link", { name: "Advanced" })).toHaveAttribute("aria-current", "location");
    await waitFor(() => expect(scroll.mock.contexts.some((el) => (el as HTMLElement).id === "advanced")).toBe(true));
    scroll.mockRestore();
  });

  it("About: the build, and a check-for-updates button", async () => {
    await open();
    const about = screen.getByRole("region", { name: "About" });
    expect(within(about).getByText(new RegExp(`build ${__BUILD_INFO__.id}`))).toBeInTheDocument();
    expect(within(about).getByRole("button", { name: "Check for updates" })).toBeEnabled();
    expect(within(about).getByText("Open-source licences")).toBeInTheDocument();
  });
});
