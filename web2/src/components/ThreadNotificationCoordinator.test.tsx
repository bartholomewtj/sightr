import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __reloadAlertPrefs, setInAppAlerts } from "@/hooks/use-alert-prefs";
import { FakeEventSource } from "@/test/fake-event-source";
import { shellSnapshot, thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import type { Thread } from "@shared/v2/contracts";

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));
let sequence = 10;
const push = (threads: Thread[]) => frame(() => shellSource()!.emit("snapshot", shellSnapshot(++sequence, threads)));

async function boot(path: string, threads: Thread[], width = 800) {
  setViewportWidth(width);
  const app = renderApp(path);
  await waitFor(() => expect(shellSource()).toBeDefined());
  push(threads);
  return app;
}

const working = (id: string, title: string) => thread(id, { title, status: "working" });
const settle = () => act(async () => {});

afterEach(() => {
  Reflect.deleteProperty(navigator, "setAppBadge");
  Reflect.deleteProperty(navigator, "clearAppBadge");
  localStorage.clear();
  __reloadAlertPrefs();
});

describe("ThreadNotificationCoordinator", () => {
  it("toasts 'X needs you' with an Open action that goes to the thread, from inside another thread", async () => {
    const { router } = await boot("/v2/thread/a", [working("a", "Alpha"), working("b", "Beta")]);
    await screen.findByRole("heading", { name: "Alpha" });
    push([working("a", "Alpha"), thread("b", { title: "Beta", status: "approval" })]);
    expect(await screen.findByText("Beta needs you")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/thread\/b$/));
    expect(screen.queryByText("Beta needs you")).toBeNull();
  });

  it("says finished for a thread that completed unread, and raises a failure as an alert", async () => {
    await boot("/v2/thread/a", [working("a", "Alpha"), working("b", "Beta"), working("c", "Gamma")]);
    await screen.findByRole("heading", { name: "Alpha" });
    push([
      working("a", "Alpha"),
      thread("b", { title: "Beta", status: "done", unreadDone: true }),
      thread("c", { title: "Gamma", status: "failed" }),
    ]);
    expect(await screen.findByText("Beta finished")).toBeInTheDocument();
    expect(screen.getByText("Gamma failed").closest("[role=alert]")).not.toBeNull();
  });

  it("never toasts for the open thread", async () => {
    await boot("/v2/thread/a", [working("a", "Alpha"), working("b", "Beta")]);
    await screen.findByRole("heading", { name: "Alpha" });
    push([thread("a", { title: "Alpha", status: "approval" }), working("b", "Beta")]);
    await settle();
    expect(screen.queryByText(/Alpha needs you/)).toBeNull();
  });

  it("does not toast again for the same thread and status", async () => {
    await boot("/v2/thread/a", [working("a", "Alpha"), working("b", "Beta")]);
    await screen.findByRole("heading", { name: "Alpha" });
    const approval = thread("b", { title: "Beta", status: "approval" });
    push([working("a", "Alpha"), approval]);
    fireEvent.click(await screen.findByRole("status"));
    expect(screen.queryByText("Beta needs you")).toBeNull();
    push([working("a", "Alpha"), { ...approval, updatedAt: 5_000, lastActivityAt: 5_000 }]);
    await settle();
    expect(screen.queryByText("Beta needs you")).toBeNull();
  });

  it("stays quiet when the in-app alerts switch is off", async () => {
    setInAppAlerts(false);
    await boot("/v2/thread/a", [working("a", "Alpha"), working("b", "Beta")]);
    await screen.findByRole("heading", { name: "Alpha" });
    push([working("a", "Alpha"), thread("b", { title: "Beta", status: "approval" })]);
    await settle();
    expect(screen.queryByText("Beta needs you")).toBeNull();
  });

  it("does not toast for what was already waiting when the app opened", async () => {
    await boot("/v2/thread/a", [working("a", "Alpha"), thread("b", { title: "Beta", status: "approval" })]);
    await screen.findByRole("heading", { name: "Alpha" });
    await settle();
    expect(screen.queryByText("Beta needs you")).toBeNull();
  });

  it("stays quiet on the phone thread list, where the status dots are the screen", async () => {
    await boot("/v2/", [working("a", "Alpha"), working("b", "Beta")]);
    await screen.findByRole("navigation", { name: "Threads" });
    push([working("a", "Alpha"), thread("b", { title: "Beta", status: "approval" })]);
    await settle();
    expect(screen.queryByText("Beta needs you")).toBeNull();
  });

  it("does not toast while the page is hidden (the Web Push covers it)", async () => {
    await boot("/v2/thread/a", [working("a", "Alpha"), working("b", "Beta")]);
    await screen.findByRole("heading", { name: "Alpha" });
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      push([working("a", "Alpha"), thread("b", { title: "Beta", status: "approval" })]);
      await settle();
      expect(screen.queryByText("Beta needs you")).toBeNull();
    } finally {
      state.mockRestore();
    }
  });

  it("sets the app badge to the Needs you count and clears it at 0", async () => {
    const set = vi.fn(() => Promise.resolve());
    const clear = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { setAppBadge: set, clearAppBadge: clear });
    await boot("/v2/thread/a", [working("a", "Alpha"), working("b", "Beta"), working("c", "Gamma")]);
    await screen.findByRole("heading", { name: "Alpha" });
    push([working("a", "Alpha"), thread("b", { title: "Beta", status: "approval" }), thread("c", { title: "Gamma", status: "input" })]);
    await waitFor(() => expect(set).toHaveBeenLastCalledWith(2));
    push([working("a", "Alpha"), working("b", "Beta"), working("c", "Gamma")]);
    await waitFor(() => expect(clear).toHaveBeenCalled());
  });
});

describe("In-app alerts setting", () => {
  it("is on by default, per device, and a switch in Settings turns it off", async () => {
    await boot("/v2/settings", [working("a", "Alpha")]);
    const toggle = await screen.findByRole("switch", { name: "In-app alerts" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch", { name: "In-app alerts" })).not.toBeChecked());
    expect(localStorage.getItem("sightr:web2:in-app-alerts:v1")).toBe("off");
  });
});
