import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { NO_CAPABILITIES } from "@shared/v2/contracts";

import { useRightPanelStore } from "@/rightPanelStore";
import { FakeEventSource } from "@/test/fake-event-source";
import { shellSnapshot, thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));
const region = (name: string) => document.querySelector(`[data-region="${name}"]`);
let paneReads = 0;

beforeEach(() => {
  paneReads = 0;
  server.use(
    http.get("/api/pane/:id", () => {
      paneReads += 1;
      return HttpResponse.json({ paneId: "p-t1", text: "$ mirror\n", truncated: false, revision: 1 });
    }),
    http.get("/api/files/pane-folder", () => HttpResponse.json({ path: "" })),
    http.get("/api/files", ({ request }) =>
      new URL(request.url).searchParams.get("path") === "readme.txt"
        ? HttpResponse.json({ kind: "file", path: "readme.txt", name: "readme.txt", size: 2, mtimeMs: 1, binary: false, text: "hi" })
        : HttpResponse.json({ kind: "dir", path: "", truncated: false, entries: [{ name: "readme.txt", kind: "file", mtimeMs: 1 }] }),
    ),
    http.get("/api/files/git", () => HttpResponse.json({ available: false, reason: "not-a-repo" })),
    http.get("/api/local-servers", () => HttpResponse.json({ host: "", servers: [] })),
  );
});

/** `hasJournal: false` boots a thread with no transcript (a bare shell), which opens on the CLI. */
async function boot(path: string, width: number, { hasJournal = true }: { hasJournal?: boolean } = {}) {
  setViewportWidth(width);
  const app = renderApp(path);
  await waitFor(() => expect(shellSource()).toBeDefined());
  const t1 = thread("t1", { title: "Fix the build", capabilities: { ...NO_CAPABILITIES, hasJournal } });
  frame(() => shellSource()?.emit("snapshot", shellSnapshot(5, [t1])));
  await screen.findByRole("heading", { name: "Fix the build" });
  return app;
}

describe("right panel: desktop", () => {
  it("switches tabs, mounts only the active one, and keeps its width", async () => {
    await boot("/v2/thread/t1", 1280);
    const panel = region("right-panel") as HTMLElement;
    expect(await within(panel).findByText(/\$ mirror/)).toBeInTheDocument();
    act(() => useRightPanelStore.getState().setWidth(560));
    fireEvent.click(within(panel).getByRole("tab", { name: "Files" }));
    expect(await within(panel).findByRole("treeitem", { name: /readme\.txt/ })).toBeInTheDocument();
    expect(within(panel).queryByText(/\$ mirror/)).toBeNull();
    fireEvent.click(within(panel).getByRole("tab", { name: "Git" }));
    expect(await within(panel).findByText("This folder is not a git repository.")).toBeInTheDocument();
    expect((region("right-panel") as HTMLElement).style.width).toBe("560px");
    expect(JSON.parse(localStorage.getItem("sightr:v2:right-panel-state:v1") ?? "{}").state).toMatchObject({ width: 560, activeSurfaceId: "git" });
  });

  it("collapses with mod+alt+b and remembers it; no pane reads while closed", async () => {
    await boot("/v2/thread/t1", 1280);
    await waitFor(() => expect(paneReads).toBeGreaterThan(0));
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true, altKey: true });
    await waitFor(() => expect(region("right-panel")).toBeNull());
    expect(JSON.parse(localStorage.getItem("sightr:v2:right-panel-state:v1") ?? "{}").state.isOpen).toBe(false);
    const reads = paneReads;
    await new Promise((r) => setTimeout(r, 50));
    expect(paneReads).toBe(reads);
    fireEvent.keyDown(document.body, { key: "j", ctrlKey: true });
    await waitFor(() => expect(region("right-panel")).not.toBeNull());
  });

  it("asks before a tab switch drops unsaved edits", async () => {
    await boot("/v2/thread/t1", 1280);
    const panel = region("right-panel") as HTMLElement;
    fireEvent.click(within(panel).getByRole("tab", { name: "Files" }));
    fireEvent.click(await within(panel).findByRole("treeitem", { name: /readme\.txt/ }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Edit" }));
    fireEvent.change(within(panel).getByLabelText("Edit readme.txt"), { target: { value: "changed" } });
    fireEvent.click(within(panel).getByRole("tab", { name: "Terminal" }));
    expect(await within(panel).findByRole("alertdialog", { name: "Unsaved edits" })).toBeInTheDocument();
    expect(useRightPanelStore.getState().activeSurfaceId).toBe("files");
    fireEvent.click(within(panel).getByRole("button", { name: "Discard edits" }));
    await waitFor(() => expect(useRightPanelStore.getState().activeSurfaceId).toBe("terminal"));
  });

  it("opens a thread with no transcript on the CLI; the panel's Terminal tab defers to it", async () => {
    await boot("/v2/thread/t1", 1280, { hasJournal: false });
    const cli = region("cli") as HTMLElement;
    expect(await within(cli).findByText(/\$ mirror/)).toBeInTheDocument();
    expect(region("timeline")).toBeNull();
    // Still a composer under the CLI, so a whole command can be typed and sent.
    expect(region("composer")).not.toBeNull();
    expect(screen.getByRole("button", { name: "CLI" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Find in thread" })).toBeNull();
    const panel = region("right-panel") as HTMLElement;
    expect(within(panel).getByText("This thread's terminal is the main view.")).toBeInTheDocument();
    expect(within(panel).queryByText(/\$ mirror/)).toBeNull();

    // The panel's button moves the timeline back to the main view and the terminal into the panel.
    fireEvent.click(within(panel).getByRole("button", { name: "Show the thread there instead" }));
    await waitFor(() => expect(region("timeline")).not.toBeNull());
    expect(region("cli")).toBeNull();
    expect(await within(region("right-panel") as HTMLElement).findByText(/\$ mirror/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread" })).toHaveAttribute("aria-pressed", "true");

    // ctrl+j (terminal.toggle) on such a thread flips the main view rather than the panel.
    fireEvent.keyDown(document.body, { key: "j", ctrlKey: true });
    await waitFor(() => expect(region("cli")).not.toBeNull());
    expect(region("right-panel")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Thread" }));
    await waitFor(() => expect(region("timeline")).not.toBeNull());
  });

  it("keeps the timeline and toggle-free header for a thread with a transcript", async () => {
    await boot("/v2/thread/t1", 1280);
    expect(region("timeline")).not.toBeNull();
    expect(region("cli")).toBeNull();
    expect(screen.queryByRole("group", { name: "Main view" })).toBeNull();
    expect(screen.getByRole("button", { name: "Find in thread" })).toBeInTheDocument();
  });

  it("says Open a thread with no thread open", async () => {
    setViewportWidth(1280);
    renderApp("/v2/");
    await waitFor(() => expect(region("right-panel")).not.toBeNull());
    expect(await within(region("right-panel") as HTMLElement).findByText("Open a thread")).toBeInTheDocument();
  });
});

describe("right panel: phone", () => {
  it("opens one tab as a sheet from the thread header; back closes it and stays on the thread", async () => {
    const { router } = await boot("/v2/thread/t1", 390);
    expect(region("right-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Files", { selector: "h2" })).toBeInTheDocument();
    expect(await within(sheet).findByRole("treeitem", { name: /readme\.txt/ })).toBeInTheDocument();
    act(() => useRightPanelStore.getState().openSheet("terminal"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(useRightPanelStore.getState().sheet).toBeNull());
    expect(router.history.location.pathname).toBe("/v2/thread/t1");
  });

  it("opens a thread with no transcript on the CLI, with no Terminal sheet button", async () => {
    await boot("/v2/thread/t1", 390, { hasJournal: false });
    expect(await within(region("cli") as HTMLElement).findByText(/\$ mirror/)).toBeInTheDocument();
    const tools = screen.getByRole("group", { name: "Thread tools" });
    expect(within(tools).queryByRole("button", { name: "Terminal" })).toBeNull();
    expect(within(tools).getByRole("button", { name: "Files" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Thread" }));
    await waitFor(() => expect(region("timeline")).not.toBeNull());
    expect(within(tools).getByRole("button", { name: "Terminal" })).toBeInTheDocument();
  });
});
