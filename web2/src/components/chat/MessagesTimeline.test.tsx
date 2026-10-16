import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueuedMessage, Run, Thread, TurnItem } from "@shared/v2/contracts";

import { applyThreadEvent, threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { followTimeline, loadOlderHistory, useHistoryState } from "@/state/timeline";
import { thread as threadFixture } from "@/test/fixtures";
import { installListLayout } from "@/test/list-layout";
import { server } from "@/test/setup";
import { assistant, command, reasoning, resetOrdinals, run, screen as screenItem, user } from "@/test/turn-items";

import { MessagesTimeline } from "./MessagesTimeline";

beforeEach(() => {
  resetOrdinals();
  installListLayout();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

interface Show {
  runs?: Run[];
  thread?: Partial<Thread>;
  queue?: QueuedMessage[];
  historyCursor?: string | null;
  syncing?: boolean;
}

function setThread(items: TurnItem[], opts: Show = {}, sequence = 1): void {
  useThreadStore.setState({
    current: threadFromSnapshot(
      {
        sequence,
        thread: threadFixture("t1", { capabilities: { ...threadFixture("t1").capabilities, hasJournal: true }, ...opts.thread }),
        runs: opts.runs ?? [],
        items,
        requests: [],
        queue: opts.queue ?? [],
        historyCursor: opts.historyCursor ?? null,
      },
      opts.syncing ?? false,
    ),
    missing: null,
  });
}

async function show(items: TurnItem[], opts: Show = {}) {
  setThread(items, opts);
  const utils = render(<MessagesTimeline threadId="t1" />);
  await settle();
  return utils;
}

async function settle(ms = 50) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const rowEl = (id: string) => document.querySelector(`[data-timeline-row-id="${CSS.escape(id)}"]`);
const inRun = { runId: "r1" };
const done = run("r1");
const live = run("r1", { status: "running", completedAt: undefined, startedAt: Date.now() - 84_000 });

describe("MessagesTimeline: states", () => {
  it("shows skeleton rows before the stream is synchronized", async () => {
    await show([], { syncing: true });
    expect(document.querySelector("[data-timeline-skeleton]")).not.toBeNull();
  });

  it("says how to start an empty thread, and points a journal-less harness at the Terminal tab", async () => {
    const { unmount } = await show([]);
    expect(screen.getByText("No messages yet. Type below to start.")).toBeInTheDocument();
    unmount();
    await show([], { thread: { capabilities: { ...threadFixture("t1").capabilities, hasJournal: false } } });
    expect(screen.getByText("This harness has no transcript. Open the Terminal tab.")).toBeInTheDocument();
  });

  it("renders user and assistant messages", async () => {
    await show([user("u:0", "hello agent"), assistant("a:0", "**hi** there")]);
    expect(screen.getByText("hello agent")).toBeInTheDocument();
    expect(screen.getByText("hi").tagName).toBe("STRONG");
  });
});

describe("MessagesTimeline: tool groups", () => {
  const groupItems = () => [
    user("u:0", "go", inRun),
    command("a:0", "ls", { ...inRun, output: "a\nb" }),
    command("b:0", "pwd", { ...inRun, output: "/x" }),
    assistant("c:0", "done", inRun),
  ];

  it("is collapsed when every tool is done, and the operator's toggle opens it", async () => {
    await show(groupItems(), { runs: [run("r1")] });
    // The settled run folds; open the fold, then the group.
    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
    await settle();
    const header = screen.getByRole("button", { name: "Ran 2 commands" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(header);
    await settle();
    expect(screen.getByRole("button", { name: "Ran 2 commands" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "Tool calls" })).toBeInTheDocument();
  });

  it("keeps the operator's toggle across an item update", async () => {
    await show(groupItems(), { runs: [run("r1")] });
    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Ran 2 commands" }));
    await settle();
    act(() => {
      const current = useThreadStore.getState().current!;
      const updated = { ...current.items["b:0"]!, updatedAt: 9_999_999 } as TurnItem;
      useThreadStore.setState({
        current: applyThreadEvent(current, { sequence: 5, threadId: "t1", type: "turn-item.updated", payload: { item: updated }, ts: 1 }),
      });
    });
    await settle();
    expect(screen.getByRole("button", { name: "Ran 2 commands" })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows a running tool as the live row while the run works", async () => {
    await show(
      [user("u:0", "go", inRun), command("a:0", "ls", inRun), command("b:0", "npm test", { ...inRun, status: "running" })],
      { runs: [live] },
    );
    expect(screen.getByText("Running npm")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Worked for/ })).toBeNull();
  });

  it("opens a failed tool by itself, in warn tokens", async () => {
    await show(
      [user("u:0", "go", inRun), command("a:0", "npm test", { ...inRun, status: "failed", output: "1 failing" }), assistant("b:0", "it failed", inRun)],
      { runs: [run("r1", { status: "failed" })] },
    );
    const row = screen.getByRole("button", { name: "npm test, tool call failed" });
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(within(row).getByLabelText("Output")).toHaveTextContent("1 failing");
  });

  it("gives a tool with no recorded output no toggle", async () => {
    await show([user("u:0", "go", inRun), command("a:0", "ls", inRun), assistant("b:0", "ok", inRun)], { runs: [live] });
    const row = document.querySelector('[data-item-type="command_execution"]')!;
    expect(row).not.toBeNull();
    expect(row.getAttribute("role")).toBeNull();
  });

  it("cuts long output at 200 lines and notes a journal-truncated item", async () => {
    const output = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
    await show(
      [user("u:0", "go", inRun), command("a:0", "seq 250", { ...inRun, output, truncated: true }), assistant("b:0", "ok", inRun)],
      { runs: [live] },
    );
    const row = screen.getByRole("button", { name: "seq 250" });
    expect(screen.queryByLabelText("Output")).toBeNull(); // lazy: not mounted until opened
    fireEvent.click(row);
    await settle();
    expect(screen.getByLabelText("Output").textContent!.split("\n")).toHaveLength(200);
    expect(document.querySelector('[data-output-note="lines"]')).toHaveTextContent("50 more lines not shown");
    expect(document.querySelector('[data-output-note="truncated"]')).not.toBeNull();
  });
});

describe("MessagesTimeline: run banner", () => {
  it("ticks the working time each second", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const start = Date.now() - 84_000;
    setThread([user("u:0", "go", inRun)], { runs: [run("r1", { status: "running", completedAt: undefined, startedAt: start })] });
    render(<MessagesTimeline threadId="t1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const banner = document.querySelector("[data-run-banner]")!;
    expect(banner).toHaveTextContent("Working for 1m 24s");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(banner).toHaveTextContent("Working for 1m 26s");
  });

  it("adds the queued count", async () => {
    const queued = (id: string, position: number): QueuedMessage =>
      ({ id, threadId: "t1", text: id, attachments: [], position, mode: "queue", state: "queued", createdAt: 1 }) as QueuedMessage;
    await show([user("u:0", "go", inRun)], { runs: [live], queue: [queued("q1", 0), queued("q2", 1)] });
    expect(document.querySelector("[data-run-banner]")).toHaveTextContent("· 2 queued");
  });

  it("reads 'Waiting for you' while the thread needs an answer", async () => {
    await show([user("u:0", "go", inRun)], { runs: [live], thread: { status: "approval" } });
    expect(document.querySelector("[data-run-banner]")).toHaveTextContent("Waiting for you");
  });

  it("notes a stopped run and a failed one", async () => {
    const { unmount } = await show([user("u:0", "go", inRun), assistant("a:0", "partial", inRun)], {
      runs: [run("r1", { status: "interrupted" })],
    });
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    unmount();
    await show([user("u:0", "go", inRun), command("a:0", "ls", inRun)], { runs: [run("r1", { status: "failed" })] });
    expect(screen.getByText("The run failed")).toBeInTheDocument();
    expect(screen.getByText(/Open the Terminal tab to see what it printed/)).toBeInTheDocument();
  });

  it("has no banner once the run is done", async () => {
    await show([user("u:0", "go", inRun), assistant("a:0", "ok", inRun)], { runs: [done] });
    expect(document.querySelector("[data-run-banner]")).toBeNull();
  });
});

describe("MessagesTimeline: reasoning", () => {
  it("collapses a thought to its duration and expands to the text", async () => {
    await show(
      [
        user("u:0", "go", { ...inRun, createdAt: 1_000_000 }),
        reasoning("t:0", "First I will check the tests.", { ...inRun, createdAt: 1_000_000 }),
        command("c:0", "ls", { ...inRun, createdAt: 1_012_000, output: "x" }),
        assistant("d:0", "ok", { ...inRun, createdAt: 1_013_000 }),
      ],
      { runs: [done] },
    );
    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
    await settle();
    // T3 keeps a thought in the work log beside the tools it led to.
    fireEvent.click(screen.getByRole("button", { name: "Ran 1 command" }));
    await settle();
    const thought = screen.getByRole("button", { name: "Thought for 12s" });
    expect(thought).toHaveTextContent("First I will check the tests.");
    fireEvent.click(thought);
    await settle();
    expect(thought).toHaveAttribute("aria-expanded", "true");
  });

  it("reads 'Thinking…' while the last item of a running run is a thought", async () => {
    await show([user("u:0", "go", inRun), reasoning("t:0", "hmm", inRun)], { runs: [live] });
    expect(screen.getByText(/Thinking…/)).toBeInTheDocument();
  });
});

describe("MessagesTimeline: virtualization", () => {
  function many(n: number): TurnItem[] {
    return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? user(`u${i}:0`, `question ${i}`) : assistant(`a${i}:0`, `answer ${i}`)));
  }

  // 5,000 items is the point of the test, and deriving their rows is slow under a loaded full run: an
  // explicit budget, and every wait is on the result (T19 hardening).
  it("mounts fewer than 80 rows for 5,000 items, and scrolling mounts the new window", async () => {
    await show(many(5000));
    const mounted = () => [...document.querySelectorAll("[data-timeline-row-id]")].map((e) => e.getAttribute("data-timeline-row-id"));
    await waitFor(() => expect(mounted()).toContain("a4999:0"), { timeout: 10_000 });
    expect(mounted().length).toBeLessThan(80);
    const scroller = document.querySelector("[data-timeline] div[style*='overflow']") as HTMLElement;
    await act(async () => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise((r) => setTimeout(r, 200));
    });
    // Under a loaded test run the list can take longer than 200 ms to mount the new window.
    await waitFor(() => expect(mounted()).toContain("u0:0"), { timeout: 10_000 });
    expect(mounted().length).toBeLessThan(80);
  }, 30_000);
});

describe("MessagesTimeline: resume and updates", () => {
  it("does not remount rows when a second snapshot has the same ids, and updates an item in place", async () => {
    const items = [user("u:0", "go", inRun), assistant("a:0", "first", inRun)];
    await show(items, { runs: [done] });
    const before = rowEl("a:0");
    expect(before).not.toBeNull();
    act(() => setThread(items.map((i) => ({ ...i })), { runs: [done] }, 50));
    await settle();
    expect(rowEl("a:0")).toBe(before);
    act(() => setThread([items[0]!, { ...items[1]!, text: "second" } as TurnItem], { runs: [done] }, 51));
    await settle();
    expect(rowEl("a:0")).toBe(before);
    expect(before).toHaveTextContent("second");
  });
});

describe("MessagesTimeline: follow mode", () => {
  it("re-follows on this client's own send", async () => {
    const items = Array.from({ length: 60 }, (_, i) => user(`u${i}:0`, `m ${i}`));
    await show(items);
    const scroller = document.querySelector("[data-timeline] div[style*='overflow']") as HTMLElement;
    await act(async () => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise((r) => setTimeout(r, 200));
    });
    await waitFor(() => expect(document.querySelector("[data-jump-to-latest]")).not.toBeNull());
    act(() => followTimeline());
    // Wait on the result, not a fixed delay: under load the scroll back to the end takes longer.
    await waitFor(() => expect(document.querySelector("[data-jump-to-latest]")).toBeNull(), { timeout: 3000 });
  });
});

describe("MessagesTimeline: history paging", () => {
  function page(nextCursor: string | null, items: TurnItem[]) {
    return { runs: [{ run: run("r0", { ordinal: 0 }), items }], loose: [], nextCursor };
  }

  it("prepends an older page without remounting the rows already shown", async () => {
    server.use(
      http.get("/api/v2/thread/t1/history", ({ request }) => {
        expect(new URL(request.url).searchParams.get("before")).toBe("c1");
        return HttpResponse.json(page(null, [user("old:0", "older question", { runId: "r0", ordinal: -2 })]));
      }),
    );
    resetOrdinals();
    await show([user("u:0", "newer", { ...inRun })], { runs: [done], historyCursor: "c1" });
    const before = rowEl("u:0");
    await act(async () => {
      await loadOlderHistory("t1");
    });
    await settle();
    expect(useThreadStore.getState().current!.items["old:0"]).toBeDefined();
    expect(rowEl("u:0")).toBe(before);
    expect(useThreadStore.getState().current!.historyCursor).toBeNull();
    expect(screen.getByText("Start of thread")).toBeInTheDocument();
  });

  it("keeps one request in flight", async () => {
    let calls = 0;
    server.use(
      http.get("/api/v2/thread/t1/history", async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return HttpResponse.json(page("c2", []));
      }),
    );
    setThread([user("u:0", "x")], { historyCursor: "c1" });
    await act(async () => {
      await Promise.all([loadOlderHistory("t1"), loadOlderHistory("t1"), loadOlderHistory("t1")]);
    });
    expect(calls).toBe(1);
    expect(useThreadStore.getState().current!.historyCursor).toBe("c2");
  });

  it("shows a retry row after a failure, not a toast loop", async () => {
    let fail = true;
    server.use(
      http.get("/api/v2/thread/t1/history", () =>
        fail ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(page(null, [])),
      ),
    );
    await show([user("u:0", "x")], { historyCursor: "c1" });
    await act(async () => {
      await loadOlderHistory("t1");
    });
    await settle();
    expect(await screen.findByText("Couldn't load earlier messages.")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Start of thread")).toBeInTheDocument());
  });

  it("exposes the paging state per thread", () => {
    let status = "";
    function Probe() {
      status = useHistoryState("t1").status;
      return null;
    }
    render(<Probe />);
    expect(status).toBe("idle");
  });
});

describe("MessagesTimeline: screen item", () => {
  it("renders a captured screen with ANSI colour and caps it with Show all", async () => {
    const text = ["\u001b[31mred\u001b[0m line", ...Array.from({ length: 59 }, (_, i) => `row ${i}`)].join("\n");
    await show([user("u:0", "go"), screenItem("s:0", text)]);
    const block = screen.getByRole("region", { name: "Screen at end of run" });
    // Capped to the last 40 lines: the red first line is hidden until Show all.
    expect(within(block).queryByText("red")).toBeNull();
    fireEvent.click(within(block).getByRole("button", { name: /Show all \(60 lines\)/ }));
    await settle();
    const red = within(block).getByText("red");
    expect(red.getAttribute("style")).toContain("var(--ansi-1)");
  });
});
