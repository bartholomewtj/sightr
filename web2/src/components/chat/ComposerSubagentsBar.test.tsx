// T34: the subagent bar above the composer: counts and newest activity, the unread dot, the list, Clear
// finished, and the agent's own view.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TurnItem } from "@shared/v2/contracts";

import { ComposerSubagentsBar } from "./ComposerSubagentsBar";

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

const byId = (...items: TurnItem[]) => Object.fromEntries(items.map((i) => [i.id, i]));

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

function fakeBridge() {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = new URL(String(input), "http://x");
    if (url.searchParams.get("latest") === "1") {
      return json({ ok: true, latest: { label: "Running", text: "git status" }, size: 1, running: true, toolCount: 1 });
    }
    return json({
      ok: true,
      size: 3,
      running: true,
      cutHead: false,
      items: [
        { id: "tu:0", threadId: T, runId: null, ordinal: 0, status: "completed", title: null, startedAt: null, completedAt: null, createdAt: 1, updatedAt: 1, type: "user_message", messageId: "tu", text: "Fix PR #1153.", attachments: [] },
        { id: "ta:0", threadId: T, runId: null, ordinal: 1, status: "completed", title: null, startedAt: null, completedAt: null, createdAt: 2, updatedAt: 2, type: "assistant_message", messageId: "ta", text: "Looking at the diff.", streaming: false },
      ],
    });
  });
}

beforeEach(() => {
  ordinal = 0;
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

const running = () =>
  agent({ title: "Fix PR #1153", subagentId: "aaaa-1", prompt: "Fix it.", agentStatus: "running", status: "running", transcript: true });
const finished = (title = "Survey src", id = "bbbb-2") =>
  agent({ title, subagentId: id, prompt: "List files.", agentStatus: "completed", result: "Two files.", durationMs: 5400 });

describe("ComposerSubagentsBar", () => {
  it("is absent when the thread has no subagents", () => {
    const { container } = render(<ComposerSubagentsBar threadId={T} items={byId()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("collapsed: the counts, and a running agent's newest action from its own log", async () => {
    fakeBridge();
    render(<ComposerSubagentsBar threadId={T} items={byId(running(), finished())} />);
    const toggle = screen.getByRole("button", { name: /^Subagents: 1 running · 1 done/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("[data-composer-subagents-count]")).toHaveTextContent("1 running");
    await waitFor(() => expect(document.querySelector("[data-composer-subagents-line]")).toHaveTextContent("Running: git status"));
  });

  it("expands in place to every agent, running first, finished ones dimmed", async () => {
    fakeBridge();
    render(<ComposerSubagentsBar threadId={T} items={byId(finished(), running())} />);
    fireEvent.click(screen.getByRole("button", { name: /^Subagents:/ }));
    const list = screen.getByRole("list", { name: "Subagents" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Fix PR #1153, Running", "Survey src, Completed"]);
    await waitFor(() => expect(within(list).getByText("Running: git status")).toBeInTheDocument());
  });

  it("Clear finished takes finished agents off the bar and keeps running ones, and it is remembered", () => {
    fakeBridge();
    const items = byId(finished(), running());
    const { unmount } = render(<ComposerSubagentsBar threadId={T} items={items} />);
    fireEvent.click(screen.getByRole("button", { name: /^Subagents:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    expect(screen.queryByRole("button", { name: "Survey src, Completed" })).toBeNull();
    expect(screen.getByRole("button", { name: "Fix PR #1153, Running" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear finished" })).toBeNull();
    unmount();
    render(<ComposerSubagentsBar threadId={T} items={items} />);
    fireEvent.click(screen.getByRole("button", { name: /^Subagents:/ }));
    expect(screen.queryByRole("button", { name: "Survey src, Completed" })).toBeNull();
  });

  it("an agent that finishes while the list is closed puts a dot on the bar; opening the list clears it", () => {
    fakeBridge();
    const launch = running();
    const { rerender } = render(<ComposerSubagentsBar threadId={T} items={byId(launch)} />);
    expect(document.querySelector("[data-subagents-unseen]")).toBeNull();
    // It finishes (the later call lands with the report).
    const done = agent({ subagentId: "aaaa-1", agentStatus: "completed", result: "All good.", status: "completed" });
    rerender(<ComposerSubagentsBar threadId={T} items={byId(launch, done)} />);
    expect(document.querySelector("[data-subagents-unseen='done']")).not.toBeNull();
    expect(screen.getByRole("button", { name: /1 finished since you last looked/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Subagents:/ }));
    expect(document.querySelector("[data-subagents-unseen]")).toBeNull();
  });

  it("history is not news: finished agents on first sight of a thread show no dot; a failure is red", () => {
    fakeBridge();
    const { rerender } = render(<ComposerSubagentsBar threadId={T} items={byId(finished())} />);
    expect(document.querySelector("[data-subagents-unseen]")).toBeNull();
    const failed = agent({ title: "Broken", subagentId: "cccc-3", agentStatus: "error", status: "failed", result: "boom" });
    rerender(<ComposerSubagentsBar threadId={T} items={byId(finished(), failed)} />);
    expect(document.querySelector("[data-subagents-unseen='failed']")).not.toBeNull();
  });

  it("older runs that load after the first render are history, not news", () => {
    fakeBridge();
    const older = finished("Old survey", "old-1"); // logged before anything the first render has
    const launch = running();
    const { rerender } = render(<ComposerSubagentsBar threadId={T} items={byId(launch)} />);
    rerender(<ComposerSubagentsBar threadId={T} items={byId(older, launch)} />);
    expect(document.querySelector("[data-subagents-unseen]")).toBeNull();
    expect(screen.getByRole("button", { name: /^Subagents: 1 running · 1 done$/ })).toBeInTheDocument();
  });

  it("a tapped agent opens its own view: a running one on the live transcript, with a way back to the list", async () => {
    fakeBridge();
    render(<ComposerSubagentsBar threadId={T} items={byId(running(), finished())} />);
    fireEvent.click(screen.getByRole("button", { name: /^Subagents:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Fix PR #1153, Running" }));
    const sheet = await waitFor(() => {
      const el = document.querySelector("[data-subagent-agent-sheet]") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(await within(sheet).findByText("Looking at the diff.")).toBeInTheDocument();
    expect(within(sheet).getByRole("tab", { name: "Transcript" })).toHaveAttribute("aria-selected", "true");
    expect(sheet.querySelector("[data-agent-status]")).toHaveTextContent("Running · live");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Details" }));
    expect(within(sheet).getByText("Fix it.")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Back to subagents" }));
    await waitFor(() => expect(document.querySelector("[data-subagent-agent-sheet]")).toBeNull());
    // The list is still open under it.
    expect(screen.getByRole("list", { name: "Subagents" })).toBeInTheDocument();
  });

  it("a finished agent opens on its details, with the result card; one with no log says so", async () => {
    fakeBridge();
    render(<ComposerSubagentsBar threadId={T} items={byId(finished())} />);
    fireEvent.click(screen.getByRole("button", { name: /^Subagents:/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Survey src, Completed" }));
    });
    const sheet = document.querySelector("[data-subagent-agent-sheet]") as HTMLElement;
    expect(within(sheet).queryByRole("tab")).toBeNull();
    expect(sheet.querySelector("[data-subagent-result]")).toHaveTextContent("Two files.");
    expect(sheet.querySelector("[data-agent-no-transcript]")).not.toBeNull();
  });
});
