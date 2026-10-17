import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { Thread } from "@shared/v2/contracts";
import { thread as threadFixture } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

import { ChatHeader, resolveRenameCommit } from "./ChatHeader";

let posts: Record<string, unknown>[] = [];

beforeEach(() => {
  posts = [];
  setViewportWidth(360);
  server.use(
    http.post("/api/v2/command", async ({ request }) => {
      posts.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ok: true, sequence: 300 + posts.length });
    }),
  );
});

function show(over: Partial<Thread> = {}, canOperate = true) {
  const t = threadFixture("t1", { title: "Fix the build", ...over });
  return render(<ChatHeader title={t.title} thread={t} canOperate={canOperate} />);
}

const trigger = () => screen.getByRole("button", { name: "Fix the build" });
async function pick(item: string | RegExp) {
  fireEvent.click(trigger());
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

describe("resolveRenameCommit (T3, verbatim)", () => {
  it("trims, refuses empty, skips no-ops", () => {
    expect(resolveRenameCommit({ title: "  New  ", originalTitle: "Old" })).toEqual({ action: "commit", title: "New" });
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({ action: "reject-empty" });
    expect(resolveRenameCommit({ title: "Old ", originalTitle: "Old" })).toEqual({ action: "noop" });
  });
});

describe("ChatHeader: the title opens the thread menu", () => {
  it("the heading keeps the title as its name and the trigger opens the sidebar's actions", async () => {
    show();
    expect(screen.getByRole("heading", { name: "Fix the build" })).toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(trigger());
    const menu = await screen.findByRole("menu", { name: "Actions for Fix the build" });
    for (const name of ["Rename", "Pin", "Mark unread", "Pick time…", "Settle", "Archive"]) {
      expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
    }
    expect(menu).toBeInTheDocument();
  });

  it("Pin, Mark unread and Settle send the thread commands", async () => {
    show();
    await pick("Pin");
    await waitFor(() => expect(posts.map((p) => p.type)).toEqual(["thread.pin"]));
    await pick("Mark unread");
    await pick("Settle");
    await waitFor(() => expect(posts.map((p) => p.type)).toEqual(["thread.pin", "thread.markUnread", "thread.settle"]));
    expect(posts.every((p) => p.threadId === "t1")).toBe(true);
  });

  it("a snooze preset sends thread.snooze with a future time", async () => {
    show();
    fireEvent.click(trigger());
    const presets = await screen.findAllByRole("menuitem");
    const preset = presets.find((p) => /tomorrow|hour|later|evening|week/i.test(p.textContent ?? ""));
    expect(preset).toBeDefined();
    fireEvent.click(preset!);
    await waitFor(() => expect(posts.map((p) => p.type)).toEqual(["thread.snooze"]));
    expect(posts[0]!.until as number).toBeGreaterThan(Date.now());
  });

  it("an unpinned/settled thread offers the inverse actions", async () => {
    show({ shelf: "pinned", unreadDone: true });
    fireEvent.click(trigger());
    expect(await screen.findByRole("menuitem", { name: "Unpin" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Mark read" })).toBeInTheDocument();
  });

  it("Rename turns the title into a field: Enter renames, Escape cancels, empty is refused", async () => {
    show();
    await pick("Rename");
    const field = await screen.findByRole("textbox", { name: "Thread title" });
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(posts).toHaveLength(0);
    fireEvent.change(field, { target: { value: "  Ship it  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(posts).toEqual([expect.objectContaining({ type: "thread.rename", threadId: "t1", title: "Ship it" })]));
    expect(screen.queryByRole("textbox", { name: "Thread title" })).toBeNull();

    await pick("Rename");
    const again = await screen.findByRole("textbox", { name: "Thread title" });
    fireEvent.change(again, { target: { value: "Nope" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Thread title" })).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it("read-only devices and archived threads get the plain title", () => {
    const { unmount } = show({}, false);
    expect(screen.getByRole("heading", { name: "Fix the build" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    show({ shelf: "archived" });
    expect(screen.queryByRole("button")).toBeNull();
  });
});
