import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { Thread } from "@shared/v2/contracts";
import { thread as threadFixture } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

import { ChatHeader } from "../chat/ChatHeader";

// "Close pane" in the thread menu (the sidebar's and the header's are the same component): shown only
// while the pane is open, two taps, sends thread.pane.close; Archive keeps the pane running.

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

function show(over: Partial<Thread> = {}) {
  const t = threadFixture("t1", { title: "Fix the build", ...over });
  return render(<ChatHeader title={t.title} thread={t} canOperate />);
}

const trigger = () => screen.getByRole("button", { name: "Fix the build" });

describe("ThreadRowMenu: Close pane", () => {
  it("is offered only while the pane is open", async () => {
    show({ paneAlive: false });
    fireEvent.click(trigger());
    await screen.findByRole("menuitem", { name: "Archive" });
    expect(screen.queryByRole("menuitem", { name: "Close pane" })).toBeNull();
  });

  it("needs a second tap, then sends thread.pane.close and nothing else", async () => {
    show({ paneAlive: true });
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close pane" }));
    // The first tap only arms: the menu stays open and nothing was sent.
    const again = await screen.findByRole("menuitem", { name: "Tap again to close pane" });
    expect(posts).toEqual([]);
    fireEvent.click(again);
    await waitFor(() => expect(posts.map((p) => p.type)).toEqual(["thread.pane.close"]));
    expect(posts[0]).toMatchObject({ threadId: "t1" });
  });

  it("Archive does not close the pane", async () => {
    show({ paneAlive: true });
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(posts.map((p) => p.type)).toEqual(["thread.archive"]));
  });
});
