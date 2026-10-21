// The structured turn items the journal adapters now emit (diffs, failed edits, task lists, plans,
// subagents, interrupts, compaction, page fetches, usage limits), rendered through the real timeline.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Run, TurnItem } from "@shared/v2/contracts";

import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { thread as threadFixture } from "@/test/fixtures";
import { installListLayout } from "@/test/list-layout";
import { assistant, edit, resetOrdinals, run, user } from "@/test/turn-items";

import { MessagesTimeline } from "./MessagesTimeline";

beforeEach(() => {
  resetOrdinals();
  installListLayout();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function settle(ms = 50) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function show(items: TurnItem[], runs: Run[]) {
  useThreadStore.setState({
    current: threadFromSnapshot(
      {
        sequence: 1,
        thread: threadFixture("t1", { capabilities: { ...threadFixture("t1").capabilities, hasJournal: true } }),
        runs,
        items,
        requests: [],
        queue: [],
        historyCursor: null,
      },
      false,
    ),
    missing: null,
  });
  render(<MessagesTimeline threadId="t1" />);
  await settle();
}

const inRun = { runId: "r1" };
const live = run("r1", { status: "running", completedAt: undefined, startedAt: Date.now() - 30_000 });

/** A bare item of `type` with the base fields, for kinds the shared factories do not cover. */
function item(id: string, fields: Record<string, unknown>): TurnItem {
  return { ...user(id, "", inRun), ...fields } as unknown as TurnItem;
}

describe("structured items in the timeline", () => {
  it("shows a file change's +/- stat on its row and opens to the coloured diff", async () => {
    const change = {
      ...edit("f:0", "C:\\demo\\src\\greet.ts", inRun),
      additions: 2,
      deletions: 1,
      diffStr: "--- a/greet.ts\n+++ b/greet.ts\n@@ -3,3 +3,4 @@\n keep\n-old\n+new\n+more",
    } as TurnItem;
    await show([user("u:0", "go", inRun), change, assistant("b:0", "ok", inRun)], [live]);
    const row = document.querySelector('[data-item-type="file_change"]') as HTMLElement;
    expect(within(row).getByRole("group", { name: "2 additions, 1 deletions" })).toBeInTheDocument();
    fireEvent.click(row);
    await settle();
    const diff = await screen.findByLabelText("Diff");
    // `+++ b/greet.ts`, `+new`, `+more` (the header carries its own muted class).
    expect(diff.querySelectorAll('[data-diff-line="+"]')).toHaveLength(3);
    expect(diff.querySelectorAll(".text-success")).toHaveLength(2);
    expect(diff.querySelector('[data-diff-line="-"]')).toBeTruthy();
  });

  it("opens a failed edit on its own with the tool's error above the diff it meant to make", async () => {
    const failed = {
      ...edit("f:0", "greet.ts", { ...inRun, status: "failed" }),
      additions: 1,
      deletions: 1,
      diffStr: "@@ @@\n-a\n+b",
      errorText: "String to replace not found in file.",
    } as TurnItem;
    await show([user("u:0", "go", inRun), failed, assistant("b:0", "ok", inRun)], [run("r1", { status: "failed" })]);
    expect(await screen.findByLabelText("Error")).toHaveTextContent("String to replace not found in file.");
    expect(screen.getByLabelText("Diff")).toBeInTheDocument();
  });

  it("keeps an older stored file change (no diff fields) as a plain row", async () => {
    await show([user("u:0", "go", inRun), edit("f:0", "src/a.ts", inRun), assistant("b:0", "ok", inRun)], [live]);
    const row = document.querySelector('[data-item-type="file_change"]') as HTMLElement;
    expect(row.getAttribute("role")).toBeNull();
    expect(within(row).queryByRole("group")).toBeNull();
  });

  it("draws a task list update as a row that opens to the checklist", async () => {
    const todo = item("t:0", {
      type: "todo_list",
      title: "TodoWrite",
      planId: "t:0",
      steps: [
        { id: "1", text: "Rename the constant", status: "completed" },
        { id: "2", text: "Run the tests", status: "running" },
        { id: "3", text: "Update the docs", status: "pending" },
      ],
    });
    await show([user("u:0", "go", inRun), todo, assistant("b:0", "ok", inRun)], [live]);
    const row = screen.getByRole("button", { name: "Updated tasks · 1/3 done" });
    fireEvent.click(row);
    await settle();
    const list = within(row).getByRole("list", { name: "Tasks" });
    expect(within(list).getAllByRole("listitem").map((li) => li.getAttribute("data-step-status"))).toEqual(["completed", "running", "pending"]);
    expect(list).toHaveTextContent("in progress: Run the tests");
  });

  it("draws a proposed plan as T3's plan card with its title and the whole plan", async () => {
    const plan = item("p:0", { type: "proposed_plan", title: "ExitPlanMode", planId: "p:0", markdown: "# Rename plan\n\n1. Rename the constant\n2. Run the tests", streaming: false });
    await show([user("u:0", "go", inRun), plan, assistant("b:0", "ok", inRun)], [run("r1")]);
    const card = document.querySelector("[data-proposed-plan]") as HTMLElement;
    expect(within(card).getByRole("heading", { name: "Rename plan" })).toBeInTheDocument();
    expect(card).toHaveTextContent("Run the tests");
    expect(within(card).getByText("Plan")).toBeInTheDocument();
  });

  it("draws a subagent row with its status and time, and opens to model, tokens and the result", async () => {
    const sub = item("s:0", {
      type: "subagent",
      title: "Survey the src folder",
      subagentId: "a1b2c3d4e5f6a7b8c",
      origin: "provider_native",
      driver: "claude",
      providerInstanceId: "claude",
      childThreadId: null,
      prompt: "List the files in src.",
      result: "Two files: **greet.ts** and index.ts.",
      model: "claude-sonnet-5-5",
      agentStatus: "completed",
      durationMs: 5400,
      tokens: "12000",
      toolUses: 3,
    });
    await show([user("u:0", "go", inRun), sub, assistant("b:0", "ok", inRun)], [run("r1")]);
    const button = screen.getByRole("button", { name: "Survey the src folder, Completed" });
    expect(button).toHaveTextContent("5.4s");
    expect(button.className).toContain("pointer-coarse:min-h-11");
    fireEvent.click(button);
    await settle();
    const detail = document.querySelector("[data-subagent-detail]") as HTMLElement;
    expect(detail).toHaveTextContent("claude-sonnet-5-5");
    expect(detail).toHaveTextContent("12,000 tokens");
    expect(detail).toHaveTextContent("3 tools");
    expect(within(detail).getByText("greet.ts").tagName).toBe("STRONG");
  });

  it("says a background subagent is still running rather than done", async () => {
    const sub = item("s:0", {
      type: "subagent",
      title: "Check the docs",
      subagentId: "b2",
      origin: "provider_native",
      driver: "claude",
      providerInstanceId: "claude",
      childThreadId: null,
      prompt: "",
      result: null,
      agentStatus: "async_launched",
    });
    await show([user("u:0", "go", inRun), sub, assistant("b:0", "ok", inRun)], [run("r1")]);
    expect(screen.getByRole("button", { name: "Check the docs, Running in the background" })).toBeInTheDocument();
  });

  it("a subagent row with no brief and no report still opens to something", async () => {
    // Pi's `get_subagent_result` while it waits: only an agent id, no prompt, no result, no status word.
    const sub = item("s:0", {
      type: "subagent",
      title: "fd9eec52-cc41-447",
      subagentId: "fd9eec52-cc41-447",
      origin: "provider_native",
      driver: "pi",
      providerInstanceId: "pi",
      childThreadId: null,
      prompt: "",
      result: null,
      status: "running",
    });
    await show([user("u:0", "go", inRun), sub, assistant("b:0", "ok", inRun)], [run("r1")]);
    fireEvent.click(screen.getByRole("button", { name: /fd9eec52-cc41-447, Running/ }));
    await settle();
    const detail = document.querySelector("[data-subagent-detail]") as HTMLElement;
    expect(detail).toHaveTextContent("fd9eec52-cc41-447");
    expect(detail).toHaveTextContent("Waiting for this agent's report");
  });

  it("draws the journal's interrupt as T3's divider, with no second Stopped notice", async () => {
    const stop = item("x:0", { type: "run_interrupt_result", message: "Stopped by the user" });
    await show([user("u:0", "go", inRun), stop], [run("r1", { status: "interrupted" })]);
    expect(screen.getByText("Run interrupted")).toBeInTheDocument();
    expect(screen.getByText(/Stopped by the user/)).toBeInTheDocument();
    expect(screen.queryByText("Stopped")).toBeNull();
    // Not a "You" bubble: the only user message is the prompt, and the marker's row is an event.
    expect(document.querySelectorAll('[data-message-role="user"]')).toHaveLength(1);
    expect(document.querySelector('[data-timeline-row-id="x:0"]')?.getAttribute("data-timeline-row-kind")).toBe("event");
  });

  it("keeps a compaction summary behind a tap", async () => {
    const compact = item("c:0", { type: "compaction", driver: "claude", summary: "Summary:\n1. Primary request: rename the constant" });
    await show([user("u:0", "go", inRun), compact, assistant("b:0", "ok", inRun)], [run("r1")]);
    expect(screen.getByText("Context compacted")).toBeInTheDocument();
    expect(screen.queryByText(/Primary request/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the compaction summary" }));
    await settle();
    expect(screen.getByText(/Primary request/)).toBeInTheDocument();
  });

  it("labels a page fetch 'Fetched <url>', not 'Searched the web'", async () => {
    const fetch = item("w:0", { type: "web_search", title: "WebFetch", patterns: ["https://example.com/docs"], results: [{ url: "https://example.com/docs", snippet: "A page." }] });
    await show([user("u:0", "go", inRun), fetch, assistant("b:0", "ok", inRun)], [live]);
    expect(screen.getByText("Fetched example.com/docs")).toBeInTheDocument();
    expect(screen.queryByText("Searched the web")).toBeNull();
  });

  it("renders a Pi error turn and a Claude usage-limit row as error rows", async () => {
    const resetAt = Date.now() + 60 * 60_000;
    const limit = item("e:0", {
      type: "error",
      status: "failed",
      failure: { class: "usage_limit", message: "You've hit your session limit · resets 2:10am", code: "rate_limit", retryable: null, resetAt },
    });
    const transport = item("e2:0", { type: "error", status: "failed", failure: { class: "transport_error", message: "Connection error.", code: null, retryable: true } });
    await show([user("u:0", "go", inRun), limit, transport], [run("r1", { status: "failed" })]);
    expect(await screen.findByText(/^Usage limit reached\. Retry after .+\.$/)).toBeInTheDocument();
    expect(screen.getByText("Connection error.")).toBeInTheDocument();
  });

  it("lists a dynamic tool's arguments when it opens", async () => {
    const tool = item("d:0", {
      type: "dynamic_tool",
      title: "mcp__srv__do",
      toolName: "mcp__srv__do",
      input: "go",
      rawInput: { target: "C:\\a\\very\\long\\path\\to\\a\\file.txt", count: 3 },
      output: "done",
    });
    await show([user("u:0", "go", inRun), tool, assistant("b:0", "ok", inRun)], [live]);
    const row = document.querySelector('[data-item-type="dynamic_tool"]') as HTMLElement;
    fireEvent.click(row);
    await settle();
    const args = within(row).getByLabelText("Arguments");
    expect(args).toHaveTextContent("target: C:\\a\\very\\long\\path\\to\\a\\file.txt");
    expect(args).toHaveTextContent("count: 3");
    expect(args.querySelector("dd")?.className).toContain("wrap-anywhere");
  });

  it("renders an approval request with subject title + detail and rich expandable details", async () => {
    const approval = item("req:0", {
      type: "approval_request",
      requestId: "r1",
      requestKind: "permission",
      prompt: "Do you want to proceed?",
      options: [{ label: "Yes" }, { label: "No" }],
      subject: {
        title: "Run command",
        target: "cd C:/bench && gh pr merge 1144",
        detail: "Record the review, merge PR 1144, remove the 7e worktree",
      },
    });
    await show([user("u:0", "go", inRun), approval, assistant("b:0", "ok", inRun)], [live]);
    // Row header displays subject, not "Do you want to proceed?"
    expect(screen.getByText("Run command · Record the review, merge PR 1144, remove the 7e worktree")).toBeInTheDocument();
    expect(screen.queryByText("Do you want to proceed?")).toBeNull();

    // Click row to open dropdown
    const row = document.querySelector('[data-item-type="approval_request"]') as HTMLElement;
    fireEvent.click(row);
    await settle();

    // Inside dropdown: target command and prompt are displayed
    expect(screen.getByText("cd C:/bench && gh pr merge 1144")).toBeInTheDocument();
    expect(screen.getByText("Do you want to proceed?")).toBeInTheDocument();
  });

  it("does not show dropdown toggle when approval request has no additional details", async () => {
    const approval = item("req:1", {
      type: "approval_request",
      title: "Approval requested",
      requestId: "r2",
      requestKind: "permission",
      prompt: "Approval requested",
    });
    await show([user("u:0", "go", inRun), approval, assistant("b:0", "ok", inRun)], [live]);
    const row = document.querySelector('[data-item-type="approval_request"]') as HTMLElement;
    // Row should not be an expandable button
    expect(row.getAttribute("role")).not.toBe("button");
  });
});
