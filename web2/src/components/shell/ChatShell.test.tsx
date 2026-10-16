import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FakeEventSource } from "@/test/fake-event-source";
import { shellSnapshot, thread, threadSnapshot } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { clampSidebarWidth, SIDEBAR_MAX, SIDEBAR_MIN, useUiState } from "@/uiStateStore";

const region = (name: string) => document.querySelector(`[data-region="${name}"]`);
const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));
const threadSources = () => FakeEventSource.instances.filter((es) => es.url.startsWith("/api/v2/thread/"));

async function boot(path: string) {
  const app = renderApp(path);
  await waitFor(() => expect(shellSource()).toBeDefined());
  frame(() => shellSource()?.emit("snapshot", shellSnapshot(5, [thread("t1", { title: "Fix the build" })])));
  return app;
}

describe("adaptive layout", () => {
  it("renders sidebar, chat and right panel at 1280 px", async () => {
    setViewportWidth(1280);
    await boot("/v2/thread/t1");
    await screen.findByRole("heading", { name: "Fix the build" });
    expect(region("sidebar")).toBeInTheDocument();
    expect(region("chat")).toBeInTheDocument();
    expect(region("right-panel")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Back to threads" })).not.toBeInTheDocument();
  });

  it("renders one stacked screen at 800 px, with a back button on a thread", async () => {
    setViewportWidth(800);
    await boot("/v2/thread/t1");
    await screen.findByRole("heading", { name: "Fix the build" });
    expect(region("sidebar")).not.toBeInTheDocument();
    expect(region("right-panel")).not.toBeInTheDocument();
    expect(region("chat")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to threads" })).toBeInTheDocument();
  });

  it("shows the thread list as home on a phone and 'Pick a thread' on desktop", async () => {
    setViewportWidth(800);
    await boot("/v2/");
    expect(await screen.findByRole("link", { name: /Fix the build/ })).toBeInTheDocument();
    act(() => setViewportWidth(1280));
    expect(await screen.findByText("Pick a thread")).toBeInTheDocument();
  });

  it("keeps the open thread, and its one stream, when the width crosses 1024 px", async () => {
    setViewportWidth(1280);
    await boot("/v2/thread/t1");
    await waitFor(() => expect(threadSources()).toHaveLength(1));
    frame(() => threadSources()[0]?.emit("snapshot", threadSnapshot(5, thread("t1", { title: "Fix the build" }))));
    act(() => setViewportWidth(800));
    expect(await screen.findByRole("heading", { name: "Fix the build" })).toBeInTheDocument();
    expect(region("sidebar")).not.toBeInTheDocument();
    act(() => setViewportWidth(1100));
    expect(screen.getByRole("heading", { name: "Fix the build" })).toBeInTheDocument();
    expect(threadSources()).toHaveLength(1);
    expect(threadSources()[0]?.closed).toBe(false);
  });

  it("collapses the right panel and remembers it", async () => {
    setViewportWidth(1280);
    await boot("/v2/");
    fireEvent.click(await screen.findByRole("button", { name: "Close the right panel" }));
    expect(region("right-panel")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("sightr:v2:right-panel-state:v1") ?? "{}").state).toMatchObject({ isOpen: false });
    fireEvent.click(await screen.findByRole("button", { name: "Open the right panel" }));
    expect(region("right-panel")).toBeInTheDocument();
  });

  it("resizes the sidebar between 200 and 480 px and stores the width", async () => {
    setViewportWidth(1280);
    await boot("/v2/");
    const handle = await screen.findByRole("separator", { name: "Resize the sidebar" });
    const start = useUiState.getState().sidebarWidth;
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(useUiState.getState().sidebarWidth).toBe(start + 16);
    expect(localStorage.getItem("sightr:v2:sidebar-width")).toBe(String(start + 16));
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(9_000)).toBe(SIDEBAR_MAX);
  });
});

describe("the root", () => {
  it("never opens two thread streams when switching threads", async () => {
    setViewportWidth(1280);
    const { router } = renderApp("/v2/thread/t1");
    await waitFor(() => expect(threadSources()).toHaveLength(1));
    await act(() => router.navigate({ to: "/thread/$threadId", params: { threadId: "t2" } }));
    await waitFor(() => expect(threadSources()).toHaveLength(2));
    expect(threadSources().filter((es) => !es.closed).map((es) => es.url)).toEqual([
      expect.stringContaining("/api/v2/thread/t2"),
    ]);
  });

  it("sends a pane deep link to its thread", async () => {
    const { router } = await boot("/v2/pane/p-t1");
    await waitFor(() => expect(router.history.location.pathname).toBe("/v2/thread/t1"));
  });

  it("sends an unknown pane home with a notice", async () => {
    setViewportWidth(800);
    const { router } = await boot("/v2/pane/nope");
    expect(await screen.findByText(/Pane not found/)).toBeInTheDocument();
    expect(router.history.location.pathname).toBe("/v2/");
  });
});
