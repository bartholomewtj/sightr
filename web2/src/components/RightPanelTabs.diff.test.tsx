// The Diff tab in the shell (T27): the fourth tab in the desktop panel and the phone sheet, `mod+d`, the palette
// action, a tap-through from a run's card, and Back closing one layer at a time over the real sheets.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { NO_CAPABILITIES } from "@shared/v2/contracts";

import { useDiffPanelStore } from "@/diffPanelStore";
import { useRightPanelStore } from "@/rightPanelStore";
import { FakeEventSource } from "@/test/fake-event-source";
import { shellSnapshot, thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { createDiffServer, type DiffServer } from "@/test/diffServer";
import { server } from "@/test/setup";

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));
const region = (name: string) => document.querySelector(`[data-region="${name}"]`);
const sleep = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const picker = () => document.querySelector("[data-diff-scope-sheet]") as HTMLElement | null;
const panelSheet = () => document.querySelector("[data-right-panel-sheet]") as HTMLElement | null;
const back = () => act(async () => { window.history.back(); await sleep(); });
let fake: DiffServer;

beforeEach(() => {
  fake = createDiffServer([{ path: "src/a.ts" }]);
  server.use(
    http.get("/api/pane/:id", () => HttpResponse.json({ paneId: "p-t1", text: "$ mirror\n", truncated: false, revision: 1 })),
    http.get("/api/files/pane-folder", () => HttpResponse.json({ path: "proj" })),
    http.get("/api/files", () => HttpResponse.json({ kind: "dir", path: "", truncated: false, entries: [] })),
    http.get("/api/files/git", () => HttpResponse.json({ available: false, reason: "not-a-repo" })),
    http.get("/api/local-servers", () => HttpResponse.json({ host: "", servers: [] })),
    ...fake.handlers,
  );
});

async function boot(width: number) {
  setViewportWidth(width);
  const app = renderApp("/v2/thread/t1");
  await waitFor(() => expect(shellSource()).toBeDefined());
  frame(() => shellSource()?.emit("snapshot", shellSnapshot(5, [thread("t1", { title: "Fix the build", capabilities: { ...NO_CAPABILITIES, hasJournal: true } })])));
  await screen.findByRole("heading", { name: "Fix the build" });
  return app;
}

describe("Diff tab: desktop", () => {
  it("is the fourth tab, and shows the working tree", async () => {
    await boot(1280);
    const panel = region("right-panel") as HTMLElement;
    const toolbar = screen.getByRole("group", { name: "Right panel" });
    expect(within(toolbar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Terminal", "Files", "Git", "Diff"]);
    expect(within(panel).queryAllByRole("tab")).toHaveLength(0);
    fireEvent.click(within(toolbar).getByRole("button", { name: "Diff" }));
    expect(await within(panel).findByRole("tree", { name: "Changed files" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("sightr:v2:right-panel-state:v1") ?? "{}").state).toMatchObject({ activeSurfaceId: "diff" });
    expect(fake.listCalls).toHaveLength(1);
  });

  it("opens with mod+d and closes with it again", async () => {
    await boot(1280);
    fireEvent.keyDown(document.body, { key: "d", ctrlKey: true });
    await waitFor(() => expect(useRightPanelStore.getState()).toMatchObject({ isOpen: true, activeSurfaceId: "diff" }));
    expect(await screen.findByRole("tree", { name: "Changed files" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "d", ctrlKey: true });
    await waitFor(() => expect(useRightPanelStore.getState().isOpen).toBe(false));
  });

  it("leaves ctrl+d to an armed terminal", async () => {
    await boot(1280);
    const mirror = document.createElement("div");
    mirror.setAttribute("data-terminal-mirror", "");
    mirror.tabIndex = 0;
    document.body.appendChild(mirror);
    mirror.focus();
    fireEvent.keyDown(mirror, { key: "d", ctrlKey: true });
    await sleep(30);
    expect(useRightPanelStore.getState().activeSurfaceId).not.toBe("diff");
    mirror.remove();
  });

  it("is in the command palette as Open Diff", async () => {
    await boot(1280);
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("option", { name: /Open Diff/ }));
    await waitFor(() => expect(useRightPanelStore.getState()).toMatchObject({ isOpen: true, activeSurfaceId: "diff" }));
  });
});

describe("Diff tab: phone", () => {
  it("has a header button, and the sheet's tab strip lists four tabs and scrolls sideways", async () => {
    await boot(390);
    const tools = screen.getByRole("group", { name: "Thread tools" });
    expect(within(tools).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Terminal", "Files", "Git", "Diff"]);
    fireEvent.click(within(tools).getByRole("button", { name: "Diff" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Terminal", "Files", "Git", "Diff"]);
    const strip = within(sheet).getByRole("tablist");
    expect(strip.className).toContain("overflow-x-auto");
    expect(within(sheet).getAllByRole("tab").every((t) => t.className.includes("shrink-0"))).toBe(true);
    expect(await within(sheet).findByRole("tree", { name: "Changed files" })).toBeInTheDocument();
  });

  it("a tap on a run's changed file opens the Diff sheet on that run and file", async () => {
    await boot(390);
    act(() => useDiffPanelStore.getState().openDiffForRun("t1", "r1", "src/a.ts"));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("tab", { name: "Diff", selected: true })).toBeInTheDocument();
    expect(useDiffPanelStore.getState().scopes["t1"]).toEqual({ kind: "run", runId: "r1" });
  });

  it("Back closes the scope picker, then the panel, then stays on the thread", async () => {
    const { router } = await boot(390);
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    const panel = await screen.findByRole("dialog");
    fireEvent.click(await within(panel).findByRole("button", { name: "Compare: Working tree" }));
    await waitFor(() => expect(picker()).not.toBeNull());
    expect(panelSheet()).not.toBeNull(); // both are open: the picker over the panel

    // One Back: the picker goes, the panel stays.
    await back();
    await waitFor(() => expect(picker()).toBeNull());
    expect(panelSheet()).not.toBeNull();
    expect(useRightPanelStore.getState().sheet).toBe("diff");
    expect(within(screen.getByRole("dialog")).getByRole("tab", { name: "Diff", selected: true })).toBeInTheDocument();

    // Another: the panel goes, and the thread is still there.
    await back();
    await waitFor(() => expect(useRightPanelStore.getState().sheet).toBeNull());
    await waitFor(() => expect(panelSheet()).toBeNull());
    expect(router.history.location.pathname).toBe("/v2/thread/t1");
    expect(screen.getByRole("heading", { name: "Fix the build" })).toBeInTheDocument();
  });

  it("picking from the picker closes only the picker, and the next Back closes the panel", async () => {
    await boot(390);
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    const panel = await screen.findByRole("dialog");
    fireEvent.click(await within(panel).findByRole("button", { name: "Compare: Working tree" }));
    await waitFor(() => expect(picker()).not.toBeNull());
    fireEvent.click(within(picker()!).getByRole("option", { name: /Working tree/ }));
    await waitFor(() => expect(picker()).toBeNull());
    expect(panelSheet()).not.toBeNull();
    await sleep(40); // the picker's own history entry comes off
    await back();
    await waitFor(() => expect(useRightPanelStore.getState().sheet).toBeNull());
  });
});
