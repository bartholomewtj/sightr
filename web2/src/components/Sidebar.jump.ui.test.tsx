import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project, Thread } from "@shared/v2/contracts";
import { useMessageToasts } from "@/components/toast";
import { useSidebarPrefs } from "@/state/sidebar";
import { __resetWoke } from "@/state/woke";
import { FakeEventSource } from "@/test/fake-event-source";
import { project, shellSnapshot, thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

import { useSidebarSearch } from "./Sidebar.jump";

// mod+1..9 jump with hint badges, the project row's read-only branch chip, and the row menu's copy items.

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));

async function openShell(threads: Thread[], projects: Project[] = [project("w1", { label: "Sightr" })], path = "/v2/", width = 1280) {
  setViewportWidth(width);
  const utils = renderApp(path);
  await waitFor(() => expect(shellSource()).toBeDefined());
  frame(() => shellSource()!.emit("snapshot", shellSnapshot(10, threads, projects)));
  await screen.findByRole("navigation", { name: "Threads" });
  return utils;
}

const threads = [
  thread("a", { title: "Alpha", lastActivityAt: 30 }),
  thread("b", { title: "Bravo", lastActivityAt: 20 }),
  thread("c", { title: "Charlie", lastActivityAt: 10 }),
];
const hints = () => [...document.querySelectorAll("[data-jump-hint]")].map((el) => el.textContent);
const hintOn = (title: string) => screen.getByRole("link", { name: new RegExp(`^${title},`) }).closest("li")!.querySelector("[data-jump-hint]")?.textContent ?? null;

afterEach(() => {
  __resetWoke();
  useSidebarSearch.setState({ query: "" });
  useSidebarPrefs.setState({ filter: "all", collapsedProjects: [] });
  useMessageToasts.setState({ toasts: [] });
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("thread jump keys", () => {
  it("ctrl+2 opens the second thread in screen order; no Nth thread leaves the key alone", async () => {
    const { router } = await openShell(threads);
    const second = new KeyboardEvent("keydown", { key: "2", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(second));
    await waitFor(() => expect(router.history.location.pathname).toBe("/v2/thread/b"));
    expect(second.defaultPrevented).toBe(true);

    const none = new KeyboardEvent("keydown", { key: "7", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(none));
    expect(none.defaultPrevented).toBe(false);
    expect(router.history.location.pathname).toBe("/v2/thread/b");
  });

  it("follows the Needs you filter and a search, as the list on screen does", async () => {
    const mixed = [
      thread("a", { title: "Alpha", lastActivityAt: 30 }),
      thread("n", { title: "Needs it", status: "approval", lastActivityAt: 5 }),
    ];
    const { router } = await openShell(mixed);
    act(() => useSidebarPrefs.getState().setFilter("needs-you"));
    fireEvent.keyDown(document.body, { key: "1", ctrlKey: true });
    await waitFor(() => expect(router.history.location.pathname).toBe("/v2/thread/n"));

    act(() => useSidebarPrefs.getState().setFilter("all"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search threads" }), { target: { value: "alp" } });
    fireEvent.keyDown(document.body, { key: "1", ctrlKey: true });
    await waitFor(() => expect(router.history.location.pathname).toBe("/v2/thread/a"));
  });

  it("does nothing on a phone", async () => {
    const { router } = await openShell(threads, [project("w1")], "/v2/", 390);
    const event = new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(event));
    await new Promise((r) => setTimeout(r, 30));
    expect(event.defaultPrevented).toBe(false);
    expect(router.history.location.pathname).toBe("/v2/");
  });
});

describe("jump hint badges", () => {
  it("show 1 to 9 on the rows while mod is held, after a short delay, and go when it is released", async () => {
    await openShell(threads);
    expect(hints()).toEqual([]);
    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    // A tap shows nothing yet.
    expect(hints()).toEqual([]);
    await waitFor(() => expect(hints()).toEqual(["Ctrl+1", "Ctrl+2", "Ctrl+3"]));
    expect(hintOn("Alpha")).toBe("Ctrl+1");
    expect(hintOn("Charlie")).toBe("Ctrl+3");
    fireEvent.keyUp(window, { key: "Control" });
    await waitFor(() => expect(hints()).toEqual([]));
  });

  it("a quick tap of the modifier shows nothing; Ctrl+Shift is not the jump modifier", async () => {
    await openShell(threads);
    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    fireEvent.keyUp(window, { key: "Control" });
    await new Promise((r) => setTimeout(r, 300));
    expect(hints()).toEqual([]);
    fireEvent.keyDown(window, { key: "Shift", ctrlKey: true, shiftKey: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(hints()).toEqual([]);
  });

  it("number only the first nine rows", async () => {
    const many = Array.from({ length: 11 }, (_, i) => thread(`t${i}`, { title: `Thread ${String(i).padStart(2, "0")}`, lastActivityAt: 100 - i }));
    await openShell(many);
    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    await waitFor(() => expect(hints()).toHaveLength(9));
    expect(hintOn("Thread 08")).toBe("Ctrl+9");
    expect(hintOn("Thread 09")).toBeNull();
  });

  it("never show on a phone", async () => {
    await openShell(threads, [project("w1")], "/v2/", 390);
    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(hints()).toEqual([]);
  });
});

describe("branch chip", () => {
  it("shows the project's branch next to its name, read-only, and nothing when there is none", async () => {
    await openShell(
      [thread("a", { projectId: "w1" }), thread("b", { projectId: "w2" })],
      [project("w1", { label: "Sightr", branch: "feat/palette-sidebar" }), project("w2", { label: "Bench", order: 1, number: 2 })],
    );
    const withBranch = screen.getByRole("region", { name: "Sightr" });
    const chip = withBranch.querySelector("[data-branch-chip]")!;
    expect(chip).toHaveTextContent("feat/palette-sidebar");
    expect(chip).toHaveAttribute("title", "Branch feat/palette-sidebar");
    // Read-only: a plain span, no control inside it, and none that switches.
    expect(chip.querySelector("button, a, input, select")).toBeNull();
    expect(chip.closest("button")?.getAttribute("data-project-row")).toBe("");
    expect(screen.getByRole("region", { name: "Bench" }).querySelector("[data-branch-chip]")).toBeNull();
  });

  it("keeps the start and the end of a long branch name", async () => {
    const long = "feature/very-long-branch-name-for-the-sidebar/fix-login";
    await openShell([thread("a")], [project("w1", { label: "Sightr", branch: long })]);
    const chip = screen.getByRole("region", { name: "Sightr" }).querySelector("[data-branch-chip]")!;
    expect(chip.textContent).toContain("…");
    expect(chip.textContent).toContain("fix-login");
    expect(chip.textContent).toContain("feature/");
    expect(chip).toHaveAttribute("title", `Branch ${long}`);
  });
});

describe("branch chip in the new-thread header", () => {
  it("names the chosen project's branch, follows a project change, and is absent without one", async () => {
    const projects = [
      project("w1", { label: "Sightr", branch: "main" }),
      project("w2", { label: "Other", number: 2, order: 1 }),
    ];
    await openShell([thread("a")], projects, "/v2/new?project=w1");
    const header = (await screen.findByRole("region", { name: "New thread" })).querySelector("header")!;
    await waitFor(() => expect(header.querySelector("[data-branch-chip]")).toHaveTextContent("main"));
    fireEvent.click(document.querySelector<HTMLElement>("[data-draft-project-trigger]")!);
    fireEvent.click(within(await screen.findByRole("listbox", { name: "Projects" })).getByRole("button", { name: /^Other/ }));
    await waitFor(() => expect(header.querySelector("[data-branch-chip]")).toBeNull());
  });
});

describe("Woke label", () => {
  it("a snoozed thread whose snooze ran out wears Woke until it is opened; a manual wake does not", async () => {
    const past = Date.now() - 1_000;
    const later = Date.now() + 3_600_000;
    const { router } = await openShell([
      thread("a", { title: "Napper", shelf: "snoozed", snoozedUntil: past }),
      thread("b", { title: "Early", shelf: "snoozed", snoozedUntil: later }),
    ]);
    expect(document.querySelector("[data-woke]")).toBeNull();
    // The bridge wakes "a" on its own; the operator wakes "b" early.
    frame(() =>
      shellSource()!.emit("snapshot", shellSnapshot(11, [thread("a", { title: "Napper" }), thread("b", { title: "Early" })], [project("w1", { label: "Sightr" })])),
    );
    const napper = await screen.findByRole("link", { name: /^Napper, .*woke from snooze/ });
    expect(napper.querySelector("[data-woke]")).toHaveTextContent("Woke");
    expect(screen.getByRole("link", { name: /^Early,/ }).querySelector("[data-woke]")).toBeNull();
    fireEvent.click(napper);
    await waitFor(() => expect(router.history.location.pathname).toBe("/v2/thread/a"));
    await waitFor(() => expect(document.querySelector("[data-woke]")).toBeNull());
  });
});

describe("row menu: copy", () => {
  const stubClipboard = () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  };

  it("Copy thread id and Copy folder path", async () => {
    server.use(http.get("/api/files/pane-folder", () => HttpResponse.json({ path: "" })));
    const user = userEvent.setup();
    // After setup(): user-event installs its own clipboard.
    const writeText = stubClipboard();
    await openShell(threads);
    fireEvent.contextMenu(screen.getByRole("link", { name: /^Alpha,/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Copy thread id" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("a"));

    fireEvent.contextMenu(screen.getByRole("link", { name: /^Bravo,/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Copy folder path" }));
    // The Files root itself copies as ".".
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("."));
    expect(within(document.body).queryByText(/C:\\/)).toBeNull();
  });

  it("offers no folder path for a thread whose pane is still being spawned", async () => {
    await openShell([thread("s", { title: "Spawning", paneId: "" })]);
    fireEvent.contextMenu(screen.getByRole("link", { name: /^Spawning,/ }));
    expect(await screen.findByRole("menuitem", { name: "Copy thread id" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Copy folder path" })).toBeNull();
  });
});
