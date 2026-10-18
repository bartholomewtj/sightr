import { act, render, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Run, TurnItem } from "@shared/v2/contracts";
import { useMessageToasts } from "@/components/toast";
import { clearItemJump, requestItemJump, useItemJumpStore } from "@/state/itemJump";
import { useTimelineStore } from "@/state/timeline";
import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { thread as threadFixture } from "@/test/fixtures";
import { installListLayout } from "@/test/list-layout";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";
import { assistant, command, resetOrdinals, run, user } from "@/test/turn-items";

import { MessagesTimeline } from "./MessagesTimeline";

// "Open this message": the palette's Messages result asks the timeline to bring one item into view.

beforeEach(() => {
  resetOrdinals();
  installListLayout();
  clearItemJump();
  setViewportWidth(800);
  useMessageToasts.setState({ toasts: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  clearItemJump();
});

function setThread(items: TurnItem[], runs: Run[] = [], historyCursor: string | null = null): void {
  useThreadStore.setState({
    current: threadFromSnapshot(
      {
        sequence: 1,
        thread: threadFixture("t1", { capabilities: { ...threadFixture("t1").capabilities, hasJournal: true } }),
        runs,
        items,
        requests: [],
        queue: [],
        historyCursor,
      },
      false,
    ),
    missing: null,
  });
}

async function settle(ms = 50) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function show(items: TurnItem[], runs: Run[] = [], historyCursor: string | null = null) {
  setThread(items, runs, historyCursor);
  const utils = render(<MessagesTimeline threadId="t1" />);
  await settle();
  return utils;
}

const rowEl = (id: string) => document.querySelector(`[data-timeline-row-id="${CSS.escape(id)}"]`);
const toasts = () => useMessageToasts.getState().toasts.map((t) => t.text);

describe("requestItemJump", () => {
  it("rings the row of a loaded message and clears the request", async () => {
    await show([user("u:0", "first question"), assistant("a:0", "first answer"), user("u2:0", "second question")]);
    act(() => requestItemJump("t1", "a:0"));
    await waitFor(() => expect(rowEl("a:0")?.hasAttribute("data-item-jump")).toBe(true));
    expect(useItemJumpStore.getState().itemId).toBeNull();
    // The ring comes off by itself.
    await waitFor(() => expect(rowEl("a:0")?.hasAttribute("data-item-jump")).toBe(false), { timeout: 4_000 });
  });

  it("opens the folded run and tool group that hide a command, then rings its row", async () => {
    const inRun = { runId: "r1" };
    await show(
      [user("u:0", "go", inRun), command("a:0", "ls", { ...inRun, output: "x" }), command("b:0", "pwd", { ...inRun, output: "/x" }), assistant("c:0", "done", inRun)],
      [run("r1")],
    );
    expect(useTimelineStore.getState().byThread.t1?.expandedRunIds.has("r1") ?? false).toBe(false);
    act(() => requestItemJump("t1", "b:0"));
    await waitFor(() => expect(useTimelineStore.getState().byThread.t1!.expandedRunIds.has("r1")).toBe(true));
    await waitFor(() => expect(document.querySelector("[data-item-jump]")).not.toBeNull());
    expect(document.querySelector("[data-item-jump]")?.getAttribute("data-timeline-row-id")).toMatch(/:details$/);
  });

  it("pages older history until the message is loaded, then rings it", async () => {
    const pages: string[] = [];
    server.use(
      http.get("/api/v2/thread/t1/history", ({ request }) => {
        const before = new URL(request.url).searchParams.get("before");
        pages.push(before ?? "");
        const next = before === "c1" ? "c2" : null;
        const item = before === "c1" ? user("mid:0", "middle", { runId: "r1", ordinal: -2 }) : user("old:0", "oldest", { runId: "r0", ordinal: -4 });
        return HttpResponse.json({ runs: [{ run: run(before === "c1" ? "r1" : "r0", { ordinal: before === "c1" ? 1 : 0 }), items: [item] }], loose: [], nextCursor: next });
      }),
    );
    await show([user("u:0", "newest")], [], "c1");
    act(() => requestItemJump("t1", "old:0"));
    await waitFor(() => expect(useThreadStore.getState().current!.items["old:0"]).toBeDefined(), { timeout: 4_000 });
    expect(pages).toEqual(["c1", "c2"]);
    await waitFor(() => expect(rowEl("old:0")?.hasAttribute("data-item-jump")).toBe(true), { timeout: 4_000 });
  });

  it("says so when the message is gone, and leaves the thread where it opened", async () => {
    await show([user("u:0", "only message")]);
    act(() => requestItemJump("t1", "pruned:0"));
    await waitFor(() => expect(toasts()).toContain("That message is no longer in this thread."));
    expect(useItemJumpStore.getState().itemId).toBeNull();
    expect(document.querySelector("[data-item-jump]")).toBeNull();
  });

  it("says so when earlier history cannot be loaded", async () => {
    server.use(http.get("/api/v2/thread/t1/history", () => new HttpResponse("boom", { status: 500 })));
    await show([user("u:0", "newest")], [], "c1");
    act(() => requestItemJump("t1", "old:0"));
    await waitFor(() => expect(toasts()).toContain("Couldn't load earlier messages to find it."), { timeout: 4_000 });
  });

  it("ignores a request for another thread", async () => {
    await show([user("u:0", "mine")]);
    act(() => requestItemJump("t9", "u:0"));
    await settle(150);
    expect(document.querySelector("[data-item-jump]")).toBeNull();
    expect(useItemJumpStore.getState().itemId).toBe("u:0");
  });
});
