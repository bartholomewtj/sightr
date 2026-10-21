// T34/T35: the card above the composer: only running agents, only while one runs; counts and newest
// activity, the list of running agents, and the agent's own view.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("is absent when every agent has finished", () => {
    fakeBridge();
    render(<ComposerSubagentsBar threadId={T} items={byId(finished(), finished("Other", "cccc-3"))} />);
    expect(document.querySelector("[data-composer-subagents-bar]")).toBeNull();
  });

  it("collapsed: the running count, and a running agent's newest action from its own log; finished agents are not counted", async () => {
    fakeBridge();
    render(<ComposerSubagentsBar threadId={T} items={byId(running(), finished())} />);
    const toggle = screen.getByRole("button", { name: "Subagents: 1 running" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("[data-composer-subagents-count]")).toHaveTextContent("1 running");
    await waitFor(() => expect(document.querySelector("[data-composer-subagents-line]")).toHaveTextContent("Running: git status"));
  });

  it("expands in place to the running agents only", async () => {
    fakeBridge();
    render(<ComposerSubagentsBar threadId={T} items={byId(finished(), running())} />);
    fireEvent.click(screen.getByRole("button", { name: /^Subagents:/ }));
    const list = screen.getByRole("list", { name: "Subagents" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Fix PR #1153, Running"]);
    expect(screen.queryByRole("button", { name: /Hide finished|Show finished/ })).toBeNull();
    await waitFor(() => expect(within(list).getByText("Running: git status")).toBeInTheDocument());
  });

  it("goes away the moment the last running agent finishes, and no dot is left on it", () => {
    fakeBridge();
    const launch = running();
    const { rerender } = render(<ComposerSubagentsBar threadId={T} items={byId(launch)} />);
    fireEvent.click(screen.getByRole("button", { name: /^Subagents:/ }));
    expect(screen.getByRole("list", { name: "Subagents" })).toBeInTheDocument();
    const done = agent({ subagentId: "aaaa-1", agentStatus: "completed", result: "All good.", status: "completed" });
    rerender(<ComposerSubagentsBar threadId={T} items={byId(launch, done)} />);
    expect(document.querySelector("[data-composer-subagents-bar]")).toBeNull();
    expect(document.querySelector("[data-subagents-unseen]")).toBeNull();
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

  it("an agent being watched stays open after it finishes, even though the card is gone", async () => {
    fakeBridge();
    const launch = running();
    const { rerender } = render(<ComposerSubagentsBar threadId={T} items={byId(launch)} />);
    fireEvent.click(screen.getByRole("button", { name: /^Subagents:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Fix PR #1153, Running" }));
    await waitFor(() => expect(document.querySelector("[data-subagent-agent-sheet]")).not.toBeNull());
    const done = agent({ subagentId: "aaaa-1", agentStatus: "completed", result: "All good.", status: "completed" });
    rerender(<ComposerSubagentsBar threadId={T} items={byId(launch, done)} />);
    expect(document.querySelector("[data-composer-subagents-bar]")).toBeNull();
    expect(document.querySelector("[data-subagent-agent-sheet]")).not.toBeNull();
  });
});
