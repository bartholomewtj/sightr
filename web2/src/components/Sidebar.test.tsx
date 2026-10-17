import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project, Thread, ThreadEvent } from "@shared/v2/contracts";
import { useMessageToasts } from "@/components/toast";
import { UNDO_NOTICE_MS } from "@/hooks/showThreadUndoNotice";
import { shellFromSnapshot } from "@/stream/apply";
import { useShell } from "@/stream/stores";
import { FakeEventSource } from "@/test/fake-event-source";
import { project, shellSnapshot, thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

import { LONG_PRESS_MS } from "@/components/sidebar/useLongPress";
import { handleSidebarDrop, sectionDropId, SNOOZE_DROP_MESSAGE, useSidebarDrag } from "./Sidebar.drag";

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));

type Posted = { commandId: string; type: string; threadId?: string; [k: string]: unknown };

/** Record every command post; answer 200 with rising sequences, or `status` with an error body. */
function commands(status = 200): Posted[] {
  const bodies: Posted[] = [];
  let sequence = 100;
  server.use(
    http.post("/api/v2/command", async ({ request }) => {
      bodies.push((await request.json()) as Posted);
      if (status !== 200) return HttpResponse.json({ ok: false, code: "boom", error: "bridge fell over" }, { status });
      return HttpResponse.json({ ok: true, sequence: ++sequence });
    }),
  );
  return bodies;
}

async function openShell(threads: Thread[], projects: Project[] = [project("w1", { label: "Sightr" })], path = "/v2/", width = 1280) {
  setViewportWidth(width);
  const utils = renderApp(path);
  await waitFor(() => expect(shellSource()).toBeDefined());
  frame(() => shellSource()!.emit("snapshot", shellSnapshot(10, threads, projects)));
  if (!path.startsWith("/v2/archived")) await screen.findByRole("navigation", { name: "Threads" });
  return utils;
}

const emit = (event: ThreadEvent) => frame(() => shellSource()!.emit("event", event));
const row = (title: string) => screen.getByRole("link", { name: new RegExp(`^${title},`) });
const list = (name: string) => screen.getByRole("list", { name });
/** The undo notice's text ("Settled · Undo"), once it shows. */
const undoNotice = async () => (await screen.findByRole("button", { name: "Undo" })).parentElement!.textContent;

async function menuItem(user: ReturnType<typeof userEvent.setup>, title: string, item: string | RegExp) {
  fireEvent.contextMenu(row(title));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

afterEach(() => {
  vi.useRealTimers();
  document.title = "";
});

describe("sidebar: projects, shelves, filter", () => {
  it("draws projects with shelves, worktrees nested, Snoozed and Settled collapsed with counts", async () => {
    await openShell(
      [
        thread("a", { title: "Alpha", status: "approval" }),
        thread("p", { title: "Pinned one", shelf: "pinned", pinOrder: 1 }),
        thread("s", { title: "Sleeper", shelf: "snoozed", snoozedUntil: Date.now() + 3_600_000 }),
        thread("d", { title: "Done one", shelf: "settled", settledAt: 5 }),
        thread("w", { title: "In worktree", projectId: "wt" }),
        thread("x", { title: "Gone", shelf: "archived", archivedAt: 1 }),
      ],
      [
        project("w1", { label: "Sightr", order: 0, repoKey: "/r/.git" }),
        project("wt", { label: "sightr-wt", order: 1, repoKey: "/r/.git", worktreeOf: "/r/.git" }),
      ],
    );
    expect(within(list("Sightr Pinned")).getByText("Pinned one")).toBeInTheDocument();
    expect(within(list("Sightr Active")).getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Sleeper")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Snoozed 1/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /Settled 1/ })).toBeInTheDocument();
    const wt = screen.getByRole("region", { name: "sightr-wt" });
    expect(within(wt).getByRole("img", { name: "Worktree" })).toBeInTheDocument();
    expect(within(wt).getByText("In worktree")).toBeInTheDocument();
    expect(screen.queryByText("Gone")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Archived (1)" })).toBeInTheDocument();

    // The project row shows the roll-up; collapsing keeps it and remembers it on this device.
    const projectRow = screen.getByRole("button", { name: /^Sightr/ });
    expect(within(projectRow).getByRole("img", { name: "Needs approval" })).toBeInTheDocument();
    fireEvent.click(projectRow);
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(within(projectRow).getByRole("img", { name: "Needs approval" })).toBeInTheDocument();
    expect(localStorage.getItem("sightr:v2:sidebar")).toContain("w1");
  });

  it("Needs you flattens across projects, counts on the chip and in the tab title", async () => {
    await openShell(
      [
        thread("a", { title: "Asks", status: "input" }),
        thread("b", { title: "Quiet" }),
        thread("c", { title: "Finished", status: "done", unreadDone: true, projectId: "w2" }),
        thread("d", { title: "Settled ask", status: "approval", shelf: "settled" }),
      ],
      [project("w1", { label: "Sightr" }), project("w2", { label: "Bench", order: 1 })],
    );
    await waitFor(() => expect(document.title).toBe("(2) Sightr"));
    fireEvent.click(screen.getByRole("button", { name: /Needs you/ }));
    const flat = list("Needs you");
    expect(within(flat).getAllByRole("link").map((a) => a.textContent)).toEqual([
      expect.stringContaining("Asks"),
      expect.stringContaining("Finished"),
    ]);
    expect(within(flat).getByText("Bench")).toBeInTheDocument();
    expect(localStorage.getItem("sightr:v2:sidebar")).toContain("needs-you");
  });

  it("search filters by title, project and harness into one flat list", async () => {
    await openShell([thread("a", { title: "Fix login" }), thread("b", { title: "Docs", harness: "pi", shelf: "settled" })]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search threads" }), { target: { value: "PI" } });
    expect(within(list("Search results")).getByText("Docs")).toBeInTheDocument();
    expect(screen.queryByText("Fix login")).not.toBeInTheDocument();
  });
});

describe("sidebar: commands", () => {
  it("pin, snooze, settle, archive, rename and mark unread each post their type with a unique commandId", async () => {
    const posted = commands();
    const user = userEvent.setup();
    await openShell([
      thread("t1", { title: "One" }),
      thread("t2", { title: "Two" }),
      thread("t3", { title: "Three" }),
      thread("t4", { title: "Four" }),
      thread("t5", { title: "Five" }),
      thread("t6", { title: "Six" }),
    ]);
    await menuItem(user, "One", "Pin");
    await menuItem(user, "Two", /^In 1 hour/);
    await menuItem(user, "Three", "Settle");
    await menuItem(user, "Four", "Archive");
    await menuItem(user, "Six", "Mark unread");
    await menuItem(user, "Five", "Rename");
    const input = await screen.findByRole("textbox", { name: "Thread title" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.clear(input);
    await user.type(input, "Renamed{Enter}");

    await waitFor(() => expect(posted).toHaveLength(6));
    expect(posted.map((p) => [p.type, p.threadId])).toEqual([
      ["thread.pin", "t1"],
      ["thread.snooze", "t2"],
      ["thread.settle", "t3"],
      ["thread.archive", "t4"],
      ["thread.markUnread", "t6"],
      ["thread.rename", "t5"],
    ]);
    expect(posted[1]!.until).toBeGreaterThan(Date.now());
    expect(posted[5]!.title).toBe("Renamed");
    expect(new Set(posted.map((p) => p.commandId)).size).toBe(6);
    // Optimistic: the lists changed before any event arrived.
    expect(within(list("Sightr Pinned")).getByText("One")).toBeInTheDocument();
    expect(screen.queryByText("Four")).not.toBeInTheDocument();
    expect(screen.getByText("Renamed")).toBeInTheDocument();
  });

  it("a 500 rolls the optimistic change back and says why", async () => {
    commands(500);
    const user = userEvent.setup();
    await openShell([thread("t1", { title: "One" })]);
    await menuItem(user, "One", "Settle");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't settle: bridge fell over");
    expect(within(list("Sightr Active")).getByText("One")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Settled/ })).not.toBeInTheDocument();
    // The undo for a refused change goes too.
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("another device's change arrives as a shell event and moves the row", async () => {
    await openShell([thread("t1", { title: "One" }), thread("t2", { title: "Two" })]);
    emit({ sequence: 11, threadId: "t2", type: "thread.shelf-changed", payload: { shelf: "pinned", pinOrder: 1, at: 5 }, ts: 5 });
    expect(within(list("Sightr Pinned")).getByText("Two")).toBeInTheDocument();
    emit({ sequence: 12, threadId: "t1", type: "thread.archived", payload: { reason: "user", at: 6 }, ts: 6 });
    expect(screen.queryByText("One")).not.toBeInTheDocument();
  });

  it("drops the overlay once the stream reaches the command, so the stream is the truth", async () => {
    commands();
    const user = userEvent.setup();
    await openShell([thread("t1", { title: "One" })]);
    await menuItem(user, "One", "Pin");
    await waitFor(() => expect(within(list("Sightr Pinned")).getByText("One")).toBeInTheDocument());
    // The bridge answered 101; another device unpinned it in the same breath.
    emit({ sequence: 101, threadId: "t1", type: "thread.shelf-changed", payload: { shelf: "active", at: 7 }, ts: 7 });
    await waitFor(() => expect(screen.queryByRole("list", { name: "Sightr Pinned" })).not.toBeInTheDocument());
  });
});

describe("sidebar: undo", () => {
  it("lasts 5 s, and Undo posts the inverse with the captured place", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const posted = commands();
    await openShell([thread("t1", { title: "One", shelf: "pinned", pinOrder: 2 }), thread("t2", { title: "Two" })]);
    fireEvent.contextMenu(row("One"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Settle" }));
    expect(await undoNotice()).toBe("Settled·Undo");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(posted.map((p) => p.type)).toEqual(["thread.settle", "thread.pin"]));
    expect(posted[1]).toMatchObject({ threadId: "t1", pinOrder: 2 });

    fireEvent.contextMenu(row("Two"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    await waitFor(async () => expect(await undoNotice()).toBe("Archived·Undo"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_NOTICE_MS + 10);
    });
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("a second toast replaces the first", async () => {
    commands();
    const user = userEvent.setup();
    await openShell([thread("t1", { title: "One" }), thread("t2", { title: "Two" })]);
    await menuItem(user, "One", "Settle");
    expect(await undoNotice()).toBe("Settled·Undo");
    await menuItem(user, "Two", "Archive");
    await waitFor(async () => expect(await undoNotice()).toBe("Archived·Undo"));
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  });

  it("mod+z runs the latest undo, but not inside a textarea", async () => {
    const posted = commands();
    const user = userEvent.setup();
    await openShell([thread("t1", { title: "One" })]);
    await menuItem(user, "One", "Settle");
    await waitFor(() => expect(posted).toHaveLength(1));
    const area = document.createElement("textarea");
    document.body.append(area);
    area.focus();
    fireEvent.keyDown(area, { key: "z", ctrlKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).toHaveLength(1);
    area.remove();
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(posted.map((p) => p.type)).toEqual(["thread.settle", "thread.unsettle"]));
  });
});

describe("sidebar: drag", () => {
  const seed = (threads: Thread[]) =>
    act(() => useShell.setState(shellFromSnapshot(shellSnapshot(10, threads, [project("w1", { label: "Sightr" })]))));

  it("each of the five drops posts its command", async () => {
    const posted = commands();
    seed([
      thread("a", { title: "Active" }),
      thread("p", { title: "Pinned", shelf: "pinned", pinOrder: 1 }),
      thread("q", { title: "Pinned 2", shelf: "pinned", pinOrder: 3 }),
      thread("s", { title: "Snoozed", shelf: "snoozed", snoozedUntil: Date.now() + 1e6 }),
      thread("d", { title: "Settled", shelf: "settled", settledAt: 1 }),
    ]);
    // Into Pinned at the drop index (over "q": between p and q).
    await handleSidebarDrop("a", "q");
    // From Pinned into Active.
    await handleSidebarDrop("p", sectionDropId("w1", "active"));
    // Onto the Settled header.
    await handleSidebarDrop("q", sectionDropId("w1", "settled"));
    // From Settled into Active.
    await handleSidebarDrop("d", sectionDropId("w1", "active"));
    // From Snoozed into Active: wakes.
    await handleSidebarDrop("s", sectionDropId("w1", "active"));
    expect(posted.map((p) => [p.type, p.threadId])).toEqual([
      ["thread.pin", "a"],
      ["thread.unpin", "p"],
      ["thread.settle", "q"],
      ["thread.unsettle", "d"],
      ["thread.unsnooze", "s"],
    ]);
    expect(posted[0]!.pinOrder).toBe(2);
  });

  it("reorders within Pinned with thread.pin at the new place", async () => {
    const posted = commands();
    seed([
      thread("p", { shelf: "pinned", pinOrder: 1 }),
      thread("q", { shelf: "pinned", pinOrder: 2 }),
      thread("r", { shelf: "pinned", pinOrder: 3 }),
    ]);
    await handleSidebarDrop("r", "p");
    expect(posted).toEqual([expect.objectContaining({ type: "thread.pin", threadId: "r", pinOrder: 0 })]);
  });

  it("a drop on Snoozed posts nothing, shakes the header and says to pick a time", async () => {
    const posted = commands();
    seed([thread("a"), thread("s", { shelf: "snoozed", snoozedUntil: Date.now() + 1e6 })]);
    const plan = await handleSidebarDrop("a", sectionDropId("w1", "snoozed"));
    expect(plan).toEqual({ kind: "refused-snooze" });
    expect(posted).toEqual([]);
    expect(useSidebarDrag.getState().shake).toBe(sectionDropId("w1", "snoozed"));
    expect(useMessageToasts.getState().toasts.map((t) => t.text)).toEqual([SNOOZE_DROP_MESSAGE]);
  });

  it("a drop on another project's row means nothing", async () => {
    const posted = commands();
    act(() =>
      useShell.setState(
        shellFromSnapshot(shellSnapshot(10, [thread("a"), thread("b", { projectId: "w2", shelf: "pinned", pinOrder: 1 })], [project("w1"), project("w2")])),
      ),
    );
    expect(await handleSidebarDrop("a", "b")).toEqual({ kind: "none" });
    expect(posted).toEqual([]);
  });
});

describe("sidebar: phone swipe", () => {
  const touch = (el: Element, type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number) =>
    fireEvent[type](el, { pointerId: 1, pointerType: "touch", clientX: x, clientY: y, button: 0 });

  it("a horizontal swipe reveals actions; a vertical scroll does not; a full swipe runs Pin", async () => {
    const posted = commands();
    await openShell([thread("t1", { title: "One" }), thread("t2", { title: "Two" })], undefined, "/v2/", 800);

    // Vertical: given back to the page.
    touch(row("One"), "pointerDown", 20, 20);
    touch(row("One"), "pointerMove", 23, 40);
    touch(row("One"), "pointerMove", 90, 60);
    touch(row("One"), "pointerUp", 90, 60);
    expect(screen.queryByRole("button", { name: "Pin" })).not.toBeInTheDocument();

    // Left: Settle and Archive.
    touch(row("One"), "pointerDown", 200, 20);
    touch(row("One"), "pointerMove", 185, 21);
    touch(row("One"), "pointerMove", 120, 21);
    touch(row("One"), "pointerUp", 120, 21);
    expect(screen.getByRole("button", { name: "Settle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(posted).toEqual([]);

    // Full swipe right on the other row: pins.
    touch(row("Two"), "pointerDown", 10, 50);
    touch(row("Two"), "pointerMove", 25, 51);
    touch(row("Two"), "pointerMove", 250, 52);
    touch(row("Two"), "pointerUp", 250, 52);
    await waitFor(() => expect(posted).toEqual([expect.objectContaining({ type: "thread.pin", threadId: "t2" })]));
  });
});

describe("sidebar: touch long press", () => {
  const touch = (el: Element, type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number) =>
    fireEvent[type](el, { pointerId: 1, pointerType: "touch", clientX: x, clientY: y, button: 0 });
  const held = () => new Promise((r) => setTimeout(r, LONG_PRESS_MS + 60));

  it("a long press on a thread row opens its menu on any touch screen, and does not open the thread", async () => {
    const { router } = await openShell([thread("t1", { title: "One" })], undefined, "/v2/", 1280);
    touch(row("One"), "pointerDown", 20, 20);
    await held();
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    touch(row("One"), "pointerUp", 20, 20);
    fireEvent.click(row("One"));
    expect(router.history.location.pathname).not.toContain("/thread/");
  });

  it("moving the finger cancels the press", async () => {
    await openShell([thread("t1", { title: "One" })], undefined, "/v2/", 800);
    touch(row("One"), "pointerDown", 20, 20);
    touch(row("One"), "pointerMove", 20, 60);
    await held();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
  });

  it("a long press on a project row opens Rename and does not collapse the project", async () => {
    await openShell([thread("t1", { title: "One" })], undefined, "/v2/", 390);
    const projectRow = screen.getByRole("button", { name: /^Sightr/ });
    touch(projectRow, "pointerDown", 20, 20);
    await held();
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    touch(projectRow, "pointerUp", 20, 20);
    fireEvent.click(projectRow);
    expect(projectRow).toHaveAttribute("aria-expanded", "true");
  });

  it("a plain tap on a project row still collapses it", async () => {
    await openShell([thread("t1", { title: "One" })], undefined, "/v2/", 390);
    const projectRow = screen.getByRole("button", { name: /^Sightr/ });
    touch(projectRow, "pointerDown", 20, 20);
    touch(projectRow, "pointerUp", 20, 20);
    fireEvent.click(projectRow);
    expect(projectRow).toHaveAttribute("aria-expanded", "false");
  });
});

describe("sidebar: rename", () => {
  async function startRename(user: ReturnType<typeof userEvent.setup>) {
    await openShell([thread("t1", { title: "One" })]);
    await menuItem(user, "One", "Rename");
    const input = await screen.findByRole("textbox", { name: "Thread title" });
    await waitFor(() => expect(input).toHaveFocus());
    return input;
  }

  it("Enter commits", async () => {
    const posted = commands();
    const user = userEvent.setup();
    const input = await startRename(user);
    await user.clear(input);
    await user.type(input, "  Better {Enter}");
    await waitFor(() => expect(posted).toEqual([expect.objectContaining({ type: "thread.rename", threadId: "t1", title: "Better" })]));
  });

  it("Escape cancels", async () => {
    const posted = commands();
    const user = userEvent.setup();
    const input = await startRename(user);
    await user.type(input, "zzz{Escape}");
    expect(screen.queryByRole("textbox", { name: "Thread title" })).not.toBeInTheDocument();
    expect(row("One")).toBeInTheDocument();
    expect(posted).toEqual([]);
  });

  it("an empty title is refused", async () => {
    const posted = commands();
    const user = userEvent.setup();
    const input = await startRename(user);
    await user.clear(input);
    await user.type(input, "   {Enter}");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: "Thread title" })).toBeInTheDocument();
    expect(posted).toEqual([]);
  });
});

describe("sidebar: project rename", () => {
  async function startRename(user: ReturnType<typeof userEvent.setup>) {
    await openShell([thread("t1", { title: "One" })]);
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Sightr/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Project name" });
    await waitFor(() => expect(input).toHaveFocus());
    return input;
  }

  it("Enter posts project.rename with the trimmed label", async () => {
    const posted = commands();
    const user = userEvent.setup();
    const input = await startRename(user);
    expect(input).toHaveValue("Sightr");
    await user.clear(input);
    await user.type(input, "  Work {Enter}");
    await waitFor(() => expect(posted).toEqual([expect.objectContaining({ type: "project.rename", projectId: "w1", label: "Work" })]));
    expect(screen.queryByRole("textbox", { name: "Project name" })).not.toBeInTheDocument();
  });

  it("Escape cancels and an empty name is refused", async () => {
    const posted = commands();
    const user = userEvent.setup();
    const input = await startRename(user);
    await user.clear(input);
    await user.type(input, "   {Enter}");
    expect(input).toHaveAttribute("aria-invalid", "true");
    await user.type(input, "zzz{Escape}");
    expect(screen.queryByRole("textbox", { name: "Project name" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Sightr/ })).toBeInTheDocument();
    expect(posted).toEqual([]);
  });

  it("Space on the project row opens the menu; a refusal toasts", async () => {
    const posted = commands(409);
    const user = userEvent.setup();
    await openShell([thread("t1", { title: "One" })]);
    screen.getByRole("button", { name: /^Sightr/ }).focus();
    await user.keyboard(" ");
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Project name" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, "x{Enter}");
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(await screen.findByText(/Couldn't rename/)).toBeInTheDocument();
  });
});

describe("sidebar: keyboard", () => {
  it("Up/Down move focus, Enter opens, Space opens the menu", async () => {
    const user = userEvent.setup();
    const { router } = await openShell([thread("t1", { title: "One", lastActivityAt: 9 }), thread("t2", { title: "Two", lastActivityAt: 5 })]);
    row("One").focus();
    await user.keyboard("{ArrowDown}");
    expect(row("Two")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(row("One")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("button", { name: /^Sightr/ })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(row("Two")).toHaveFocus();
    await user.keyboard(" ");
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    row("Two").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/thread/t2"));
  });
});

describe("thread route: mark read", () => {
  const threadSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/thread/t1"));

  it("does not post markRead until the thread stream is synchronized", async () => {
    const posted = commands();
    const t1 = thread("t1", { title: "One", status: "done", unreadDone: true });
    await openShell([t1], undefined, "/v2/thread/t1");
    await waitFor(() => expect(threadSource()).toBeDefined());
    frame(() =>
      threadSource()!.emit("snapshot", { sequence: 10, thread: t1, runs: [], items: [], requests: [], queue: [], historyCursor: null }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(posted).toEqual([]);
    frame(() => threadSource()!.emit("synchronized", { sequence: 10 }));
    await waitFor(() => expect(posted).toEqual([expect.objectContaining({ type: "thread.markRead", threadId: "t1" })]));
  });
});

describe("archived route", () => {
  it("lists archived threads newest first; Unarchive only while the pane exists", async () => {
    const posted = commands();
    await openShell(
      [
        thread("old", { title: "Old", shelf: "archived", archivedAt: 1_000, archiveReason: "pane-closed" }),
        thread("new", { title: "New", shelf: "archived", archivedAt: 5_000, archiveReason: "user" }),
        thread("live", { title: "Live" }),
      ],
      undefined,
      "/v2/archived",
    );
    const items = within(await screen.findByRole("list", { name: "Archived threads" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining("New"), expect.stringContaining("Old")]);
    expect(within(items[0]!).getByRole("button", { name: "Unarchive" })).toBeInTheDocument();
    expect(within(items[1]!).queryByRole("button", { name: "Unarchive" })).not.toBeInTheDocument();
    fireEvent.click(within(items[0]!).getByRole("button", { name: "Unarchive" }));
    await waitFor(() => expect(posted).toEqual([expect.objectContaining({ type: "thread.unarchive", threadId: "new" })]));
  });

  it("opening an archived thread replaces the composer", async () => {
    await openShell([thread("old", { title: "Old", shelf: "archived", archivedAt: 1, archiveReason: "pane-closed" })], undefined, "/v2/thread/old");
    expect(await screen.findByText("This thread's pane was closed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unarchive" })).not.toBeInTheDocument();
  });
});
