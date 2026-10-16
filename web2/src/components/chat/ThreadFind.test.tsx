import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Run, TurnItem } from "@shared/v2/contracts";
import { __resetDirectArm, setDirectArmed } from "@v1/lib/direct-arm";
import { ShortcutListener } from "@/components/GlobalShortcuts";
import { useShortcutHandler } from "@/shortcutHandlers";
import { useTimelineStore } from "@/state/timeline";
import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { FakeEventSource } from "@/test/fake-event-source";
import { shellSnapshot, thread as threadFixture } from "@/test/fixtures";
import { installListLayout } from "@/test/list-layout";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { assistant, command, resetOrdinals, run, user } from "@/test/turn-items";

import { MessagesTimeline } from "./MessagesTimeline";
import { searchThreadItems, stepThreadFindIndex, formatThreadFindCount, turnItemFindText } from "./threadFind";
import { TimelineFind } from "./ThreadFindBar";
import { __resetThreadFind, openThreadFind, useThreadFindStore } from "./useThreadFind";

// T19: find over the timeline (mod+f, the header's search button).

beforeEach(() => {
  resetOrdinals();
  installListLayout();
  __resetThreadFind();
  __resetDirectArm();
  setViewportWidth(800);
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetDirectArm();
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

/** What the thread route does: mod+f opens find for the open thread. */
function FindKey() {
  useShortcutHandler("chat.find", () => openThreadFind("t1"));
  return null;
}

async function show(items: TurnItem[], runs: Run[] = [], historyCursor: string | null = null) {
  setThread(items, runs, historyCursor);
  const utils = render(
    <>
      <ShortcutListener />
      <FindKey />
      <div className="relative">
        <MessagesTimeline threadId="t1" />
        <TimelineFind threadId="t1" />
      </div>
    </>,
  );
  await settle();
  return utils;
}

async function settle(ms = 50) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const findInput = () => screen.getByRole("textbox", { name: "Find in thread" });
const count = () => document.querySelector("[data-thread-find-bar] [aria-live]")?.textContent ?? "";
const ctrlF = () => fireEvent.keyDown(window, { key: "f", code: "KeyF", ctrlKey: true });

describe("threadFind helpers", () => {
  it("steps and wraps, and counts as T3 does", () => {
    expect(stepThreadFindIndex(2, 3, 1)).toBe(0);
    expect(stepThreadFindIndex(0, 3, -1)).toBe(2);
    expect(formatThreadFindCount(0, 0)).toBe("0/0");
    expect(formatThreadFindCount(1, 3)).toBe("2/3");
  });

  it("searches every item's text, case-insensitively, one match per occurrence", () => {
    const items = [user("u:0", "Alpha and alpha"), command("c:0", "ls", { output: "ALPHA" }), assistant("a:0", "none")];
    expect(searchThreadItems(items, "alpha").map((m) => [m.entryId, m.occurrence])).toEqual([
      ["u:0", 0],
      ["u:0", 1],
      ["c:0", 0],
    ]);
    expect(searchThreadItems(items, "  ")).toEqual([]);
    expect(turnItemFindText(command("x:0", "git status", { output: "clean" }))).toContain("clean");
  });
});

describe("find over the timeline", () => {
  const inRun = { runId: "r1" };
  const grouped = () => [
    user("u:0", "go", inRun),
    command("a:0", "ls", { ...inRun, output: "needle-in-output" }),
    command("b:0", "pwd", { ...inRun, output: "/x" }),
    assistant("c:0", "done", inRun),
  ];

  it("mod+f opens the bar; a hit inside a folded run's collapsed group opens both and marks its row", async () => {
    await show(grouped(), [run("r1")]);
    expect(screen.getByRole("button", { name: /Worked for/ })).toHaveAttribute("aria-expanded", "false");
    ctrlF();
    await settle();
    fireEvent.change(findInput(), { target: { value: "needle" } });
    await waitFor(() => expect(count()).toBe("1/1"));
    const ui = useTimelineStore.getState().byThread.t1!;
    await waitFor(() => expect(ui.expandedRunIds.has("r1")).toBe(true));
    expect(useTimelineStore.getState().byThread.t1!.expandedWorkGroupIds.size).toBe(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Ran 2 commands" })).toHaveAttribute("aria-expanded", "true"));
    await waitFor(() => expect(document.querySelector("[data-thread-find-active]")).not.toBeNull());
    expect(document.querySelector("[data-thread-find-active]")?.getAttribute("data-timeline-row-id")).toMatch(/:details$/);
  });

  it("next and previous wrap; Escape closes the bar and clears the marks", async () => {
    await show([user("u:0", "alpha one"), assistant("a:0", "alpha two"), user("u2:0", "alpha three")]);
    act(() => openThreadFind("t1"));
    await settle();
    fireEvent.change(findInput(), { target: { value: "alpha" } });
    await waitFor(() => expect(count()).toBe("1/3"));
    fireEvent.keyDown(findInput(), { key: "Enter", shiftKey: true });
    await waitFor(() => expect(count()).toBe("3/3"));
    await waitFor(() => expect(document.querySelector("[data-thread-find-active]")?.getAttribute("data-timeline-row-id")).toBe("u2:0"));
    fireEvent.keyDown(findInput(), { key: "Enter" });
    await waitFor(() => expect(count()).toBe("1/3"));
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    await waitFor(() => expect(count()).toBe("2/3"));
    fireEvent.keyDown(findInput(), { key: "Escape" });
    await waitFor(() => expect(document.querySelector("[data-thread-find-bar]")).toBeNull());
    expect(useThreadFindStore.getState().threadId).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-thread-find-active]")).toBeNull());
  });

  it("paints every hit with the CSS highlight API and the focused one apart", async () => {
    const highlights = new Map<string, Set<Range>>();
    class FakeHighlight extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    }
    vi.stubGlobal("Highlight", FakeHighlight);
    Object.defineProperty(CSS, "highlights", { configurable: true, value: highlights });
    try {
      await show([user("u:0", "find me here"), assistant("a:0", "and find me there")]);
      act(() => openThreadFind("t1"));
      await settle();
      fireEvent.change(findInput(), { target: { value: "find me" } });
      await waitFor(() => expect(highlights.get("sightr-thread-find-active")?.size).toBe(1));
      expect(highlights.get("sightr-thread-find")?.size).toBe(1);
      expect([...highlights.get("sightr-thread-find-active")!][0]!.toString().toLowerCase()).toBe("find me");
      act(() => useThreadFindStore.setState({ threadId: null, query: "" }));
      await waitFor(() => expect(highlights.has("sightr-thread-find-active")).toBe(false));
    } finally {
      delete (CSS as { highlights?: unknown }).highlights;
      vi.unstubAllGlobals();
    }
  });

  it('says "Loaded messages only" while older history exists', async () => {
    await show([user("u:0", "hello")], [], "cursor-1");
    act(() => openThreadFind("t1"));
    await settle();
    expect(screen.getByText("Loaded messages only")).toBeInTheDocument();
  });

  it("mod+f is ignored while direct typing is armed", async () => {
    await show([user("u:0", "hello")]);
    setDirectArmed(true);
    ctrlF();
    await settle();
    expect(document.querySelector("[data-thread-find-bar]")).toBeNull();
    setDirectArmed(false);
    ctrlF();
    await settle();
    expect(document.querySelector("[data-thread-find-bar]")).not.toBeNull();
  });
});

describe("find in the thread route", () => {
  it("the header's search button opens the bar", async () => {
    renderApp("/v2/thread/t1");
    await waitFor(() => expect(FakeEventSource.instances.some((es) => es.url.startsWith("/api/v2/shell"))).toBe(true));
    frame(() => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"))?.emit("snapshot", shellSnapshot(5)));
    fireEvent.click(await screen.findByRole("button", { name: "Find in thread" }));
    expect(await screen.findByRole("search", { name: "Find in thread" })).toBeInTheDocument();
  });
});
