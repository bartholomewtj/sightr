// T35: the header's subagents button: absent with no agents, a running badge, the unread dot, and the sheet
// listing every agent (finished ones too) with each agent's own view over it.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TurnItem } from "@shared/v2/contracts";

const store = vi.hoisted(() => ({ items: {} as Record<string, unknown> }));
vi.mock("@/stream/stores", () => ({
  useThread: () => ({ items: store.items }),
}));

import { ThreadSubagentsButton } from "./ThreadSubagentsButton";

const T = "t1";
let ordinal = 0;

function agent(over: Record<string, unknown>): TurnItem {
  ordinal += 1;
  return {
    id: `s:${ordinal}`,
    threadId: T,
    runId: "r1",
    ordinal,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    createdAt: ordinal * 1000,
    updatedAt: ordinal * 1000,
    type: "subagent",
    origin: "provider_native",
    driver: "pi",
    providerInstanceId: "pi",
    childThreadId: null,
    prompt: "",
    result: null,
    ...over,
  } as unknown as TurnItem;
}

const setItems = (...items: TurnItem[]) => {
  store.items = Object.fromEntries(items.map((i) => [i.id, i]));
};

const json = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

function fakeBridge() {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = new URL(String(input), "http://x");
    if (url.searchParams.get("latest") === "1") {
      return json({ ok: true, latest: { label: "Running", text: "git status" }, size: 1, running: true, toolCount: 1 });
    }
    return json({ ok: true, size: 0, running: true, cutHead: false, items: [] });
  });
}

beforeEach(() => {
  ordinal = 0;
  store.items = {};
  window.localStorage.clear();
  fakeBridge();
});
afterEach(() => vi.restoreAllMocks());

const running = (id = "aaaa-1") =>
  agent({ title: "Fix PR #1153", subagentId: id, prompt: "Fix it.", agentStatus: "running", status: "running", transcript: true });
const finished = (title = "Survey src", id = "bbbb-2") =>
  agent({ title, subagentId: id, prompt: "List files.", agentStatus: "completed", result: "Two files.", durationMs: 5400 });

describe("ThreadSubagentsButton", () => {
  it("is absent when the thread has no subagents", () => {
    const { container } = render(<ThreadSubagentsButton threadId={T} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is present when only finished agents exist, with no running badge", () => {
    setItems(finished());
    render(<ThreadSubagentsButton threadId={T} />);
    expect(screen.getByRole("button", { name: "Subagents: 1 done" })).toBeInTheDocument();
    expect(document.querySelector("[data-subagents-running]")).toBeNull();
  });

  it("shows the running count as a badge", () => {
    setItems(running(), running("aaaa-9"), finished());
    render(<ThreadSubagentsButton threadId={T} />);
    expect(document.querySelector("[data-subagents-running]")).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Subagents: 2 running · 1 done/ })).toBeInTheDocument();
  });

  it("opens a sheet listing every agent: running first, finished dimmed, with each one's status", () => {
    setItems(finished(), running());
    render(<ThreadSubagentsButton threadId={T} />);
    fireEvent.click(screen.getByRole("button", { name: /^Subagents:/ }));
    const sheet = document.querySelector("[data-thread-subagents-sheet]") as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(sheet.querySelector("[data-thread-subagents-line]")).toHaveTextContent("1 running · 1 done");
    const rows = within(within(sheet).getByRole("list", { name: "All subagents" })).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Fix PR #1153, Running", "Survey src, Completed"]);
  });

  it("an agent that finishes while the sheet is closed puts a dot on the button; opening the sheet clears it", () => {
    const launch = running();
    setItems(launch);
    const { rerender } = render(<ThreadSubagentsButton threadId={T} />);
    expect(document.querySelector("[data-subagents-unseen]")).toBeNull();
    setItems(launch, agent({ subagentId: "aaaa-1", agentStatus: "completed", result: "All good.", status: "completed" }));
    rerender(<ThreadSubagentsButton threadId={T} />);
    expect(document.querySelector("[data-subagents-unseen='done']")).not.toBeNull();
    expect(screen.getByRole("button", { name: /1 finished since you last looked/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Subagents:/ }));
    expect(document.querySelector("[data-subagents-unseen]")).toBeNull();
  });

  it("history is not news, and a failure is red", () => {
    setItems(finished());
    const { rerender } = render(<ThreadSubagentsButton threadId={T} />);
    expect(document.querySelector("[data-subagents-unseen]")).toBeNull();
    setItems(finished(), agent({ title: "Broken", subagentId: "cccc-3", agentStatus: "error", status: "failed", result: "boom" }));
    rerender(<ThreadSubagentsButton threadId={T} />);
    expect(document.querySelector("[data-subagents-unseen='failed']")).not.toBeNull();
  });

  it("older runs that load after the first render are history, not news", () => {
    const older = finished("Old survey", "old-1");
    const launch = running();
    setItems(launch);
    const { rerender } = render(<ThreadSubagentsButton threadId={T} />);
    setItems(older, launch);
    rerender(<ThreadSubagentsButton threadId={T} />);
    expect(document.querySelector("[data-subagents-unseen]")).toBeNull();
  });

  it("a tapped finished agent opens its own view over the list; back returns to the list", async () => {
    setItems(finished());
    render(<ThreadSubagentsButton threadId={T} />);
    fireEvent.click(screen.getByRole("button", { name: /^Subagents:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Survey src, Completed" }));
    const view = await waitFor(() => {
      const el = document.querySelector("[data-subagent-agent-sheet]") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(view.querySelector("[data-subagent-result]")).toHaveTextContent("Two files.");
    fireEvent.click(within(view).getByRole("button", { name: "Back to subagents" }));
    await waitFor(() => expect(document.querySelector("[data-subagent-agent-sheet]")).toBeNull());
    expect(document.querySelector("[data-thread-subagents-sheet]")).not.toBeNull();
  });
});
