import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NO_CAPABILITIES } from "@shared/v2/contracts";
import { openCommandPalette, useCommandPaletteStore } from "@/commandPaletteBus";
import { useThreadFindStore } from "@/components/chat/useThreadFind";
import { useMessageToasts } from "@/components/toast";
import { __resetRightPanelStore, useRightPanelStore } from "@/rightPanelStore";
import { FakeEventSource } from "@/test/fake-event-source";
import { shellSnapshot, thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

// Open file…, Find in thread, Copy thread id and Copy folder path in the command palette.

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));
const journaled = { ...NO_CAPABILITIES, hasJournal: true };

async function boot(path: string, width = 1280, caps = journaled) {
  setViewportWidth(width);
  const app = renderApp(path);
  await waitFor(() => expect(shellSource()).toBeDefined());
  frame(() => shellSource()?.emit("snapshot", shellSnapshot(5, [thread("t1", { title: "Fix the build", capabilities: caps })])));
  return app;
}

const palette = () => screen.findByTestId("command-palette");
const modK = () => fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });

const searches: string[] = [];
function filesApi(results: { path: string; name: string; kind: "file" | "dir" }[] | "off" = []) {
  searches.length = 0;
  server.use(
    http.get("/api/files/search", ({ request }) => {
      searches.push(new URL(request.url).searchParams.get("q") ?? "");
      if (results === "off") return new HttpResponse("off", { status: 404 });
      return HttpResponse.json({ q: "", results, truncated: false });
    }),
  );
}

/** Open the palette and click the action named `name` (typed after ">" so only actions show). */
async function pickAction(name: RegExp) {
  modK();
  const dialog = await palette();
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: ">" } });
  fireEvent.click(await within(dialog).findByRole("option", { name }));
  return dialog;
}

const stubClipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
};

/** Every Files-tab open request the store sees (the mounted Files tab takes the request at once). */
const fileRequests = () => {
  const seen: { threadId: string; path: string; kind: string }[] = [];
  const off = useRightPanelStore.subscribe((s) => {
    if (s.fileRequest && !seen.some((r) => r === s.fileRequest)) seen.push(s.fileRequest);
  });
  return { seen, off };
};
const toasts = () => useMessageToasts.getState().toasts.map((t) => t.text);
const COMMANDS_PLACEHOLDER = expect.stringMatching(/threads, projects/i);

afterEach(() => {
  useThreadFindStore.setState({ threadId: null, query: "" });
  useMessageToasts.setState({ toasts: [] });
  __resetRightPanelStore();
  useRightPanelStore.setState({ fileRequest: null, sheet: null });
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("palette: Open file…", () => {
  it("switches to a file search over the Files API and opens the pick in the Files tab", async () => {
    filesApi([
      { path: "src/main.ts", name: "main.ts", kind: "file" },
      { path: "docs", name: "docs", kind: "dir" },
    ]);
    await boot("/v2/thread/t1");
    const dialog = await pickAction(/Open file/);
    // Still open; now a file list with its own placeholder and a way back.
    expect(useCommandPaletteStore.getState().open).toBe(true);
    const input = within(dialog).getByRole("combobox");
    expect(input).toHaveAttribute("placeholder", expect.stringMatching(/files by name/i));
    expect(within(dialog).getByRole("button", { name: "Back to commands" })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "m" } });
    expect(await within(dialog).findByText(/at least 2 characters/i)).toBeInTheDocument();
    expect(searches).toEqual([]);

    fireEvent.change(input, { target: { value: "ma" } });
    const option = await within(dialog).findByRole("option", { name: /main\.ts/ });
    expect(option).toHaveTextContent("src");
    expect(searches).toEqual(["ma"]);
    const { seen, off } = fileRequests();
    fireEvent.click(option);
    await waitFor(() => expect(useCommandPaletteStore.getState().open).toBe(false));
    expect(seen).toMatchObject([{ threadId: "t1", path: "src/main.ts", kind: "file" }]);
    expect(useRightPanelStore.getState()).toMatchObject({ isOpen: true, activeSurfaceId: "files" });
    off();
  });

  it("Enter opens the first result, and a folder opens as a folder", async () => {
    filesApi([{ path: "docs", name: "docs", kind: "dir" }]);
    await boot("/v2/thread/t1");
    const dialog = await pickAction(/Open file/);
    const input = within(dialog).getByRole("combobox");
    fireEvent.change(input, { target: { value: "do" } });
    await within(dialog).findByRole("option", { name: /docs/ });
    const { seen, off } = fileRequests();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(seen).toMatchObject([{ path: "docs", kind: "dir" }]));
    off();
  });

  it("on a phone the pick opens the Files sheet", async () => {
    filesApi([{ path: "a.txt", name: "a.txt", kind: "file" }]);
    await boot("/v2/thread/t1", 390);
    fireEvent.click(await screen.findByRole("button", { name: "Command palette" }));
    const dialog = await palette();
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: ">open file" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /Open file/ }));
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "a.t" } });
    const { seen, off } = fileRequests();
    fireEvent.click(await within(dialog).findByRole("option", { name: /a\.txt/ }));
    await waitFor(() => expect(useRightPanelStore.getState().sheet).toBe("files"));
    expect(seen).toMatchObject([{ path: "a.txt" }]);
    off();
  });

  it("Backspace on an empty box and the Back button return to the commands", async () => {
    filesApi();
    await boot("/v2/thread/t1");
    const dialog = await pickAction(/Open file/);
    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Backspace" });
    await waitFor(() => expect(within(dialog).getByRole("combobox")).toHaveAttribute("placeholder", COMMANDS_PLACEHOLDER));
    fireEvent.click(await within(dialog).findByRole("option", { name: /Open file/ }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Back to commands" }));
    await waitFor(() => expect(within(dialog).getByRole("combobox")).toHaveAttribute("placeholder", COMMANDS_PLACEHOLDER));
  });

  it("says why when nothing matches and when Files is off", async () => {
    filesApi([]);
    await boot("/v2/thread/t1");
    const dialog = await pickAction(/Open file/);
    const input = within(dialog).getByRole("combobox");
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(await within(dialog).findByText("No files match.")).toBeInTheDocument();
    filesApi("off");
    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(await within(dialog).findByText(/SIGHTR_WORK_ROOT/)).toBeInTheDocument();
  });

  it("is offered only in a thread", async () => {
    await boot("/v2/");
    modK();
    const dialog = await palette();
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: ">file" } });
    await waitFor(() => expect(within(dialog).queryAllByRole("option")).toHaveLength(0));
  });

  it("opened straight into the mode, it never hands an unsafe path to the Files tab", async () => {
    filesApi([
      { path: "../outside.txt", name: "outside.txt", kind: "file" },
      { path: "ok.txt", name: "ok.txt", kind: "file" },
    ]);
    await boot("/v2/thread/t1");
    act(() => openCommandPalette({ mode: "files" }));
    const dialog = await palette();
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "txt" } });
    await within(dialog).findByRole("option", { name: /ok\.txt/ });
    expect(within(dialog).queryByRole("option", { name: /outside/ })).toBeNull();
  });
});

describe("palette: Find in thread and copy actions", () => {
  it("Find in thread opens the thread's find bar", async () => {
    await boot("/v2/thread/t1");
    await pickAction(/Find in thread/);
    await waitFor(() => expect(useCommandPaletteStore.getState().open).toBe(false));
    expect(useThreadFindStore.getState().threadId).toBe("t1");
  });

  it("is not offered on a thread shown as its CLI, which has its own find", async () => {
    await boot("/v2/thread/t1", 1280, NO_CAPABILITIES);
    modK();
    const dialog = await palette();
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: ">find" } });
    await waitFor(() => expect(within(dialog).queryByRole("option", { name: /Find in thread/ })).toBeNull());
  });

  it("Copy thread id writes the id to the clipboard and says so", async () => {
    const writeText = stubClipboard();
    await boot("/v2/thread/t1");
    await pickAction(/Copy thread id/);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(toasts()).toContain("Thread id copied"));
  });

  it("Copy folder path copies the Files-relative folder the bridge names", async () => {
    const writeText = stubClipboard();
    server.use(http.get("/api/files/pane-folder", () => HttpResponse.json({ path: "proj/src" })));
    await boot("/v2/thread/t1");
    await pickAction(/Copy folder path/);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("proj/src"));
    await waitFor(() => expect(toasts()).toContain("Folder path copied"));
  });

  it("Copy folder path says so when the folder is outside the Files root, and copies nothing", async () => {
    const writeText = stubClipboard();
    server.use(http.get("/api/files/pane-folder", () => HttpResponse.json({ path: null })));
    await boot("/v2/thread/t1");
    await pickAction(/Copy folder path/);
    await waitFor(() => expect(toasts()).toContain("This folder isn't under the Files root"));
    expect(writeText).not.toHaveBeenCalled();
  });
});
