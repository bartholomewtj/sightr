// The composer's status pieces fed by the bridge's structured items: the error / usage-limit banner
// (ThreadErrorBanner, UsageLimitRecoveryBanner), the context window meter and the tasks badge.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { capabilitiesFor } from "@shared/agents";
import type { PlanStep, Run, Thread, TurnItem } from "@shared/v2/contracts";
import { __setComposerDeps } from "@/state/composer";
import { threadFromSnapshot } from "@/stream/apply";
import { useStreamHealth, useThreadStore } from "@/stream/stores";
import { thread as threadFixture } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

import { ChatComposer } from "./ChatComposer";
import { __resetDismissedThreadErrors } from "./ThreadErrorBanner";
import { usageLimitResetLabel } from "./UsageLimitRecoveryBanner";

let posts: Record<string, unknown>[] = [];

beforeEach(() => {
  posts = [];
  setViewportWidth(390);
  __resetDismissedThreadErrors();
  let n = 0;
  __setComposerDeps({ command: () => ({ fetch: (...a) => globalThis.fetch(...a), newId: () => `cmd-${++n}` }) });
  server.use(
    http.post("/api/v2/command", async ({ request }) => {
      posts.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ok: true, sequence: 200 + posts.length });
    }),
  );
  useStreamHealth.setState({ status: "live" });
});

const base = { threadId: "t1", status: "completed", title: null, startedAt: null, completedAt: null, createdAt: 1, updatedAt: 1 } as const;
const failedRun: Run = { id: "r1", threadId: "t1", ordinal: 1, status: "failed", startedAt: 1_000, completedAt: 2_000 };

function errorItem(id: string, failure: Partial<Extract<TurnItem, { type: "error" }>["failure"]> = {}): TurnItem {
  return {
    ...base,
    id,
    runId: "r1",
    ordinal: 3,
    status: "failed",
    type: "error",
    failure: { class: "provider_error", message: "API Error: Connection dropped (ECONNRESET)", code: null, retryable: true, ...failure },
  };
}
function todo(steps: PlanStep[], runId = "r1"): TurnItem {
  return { ...base, id: "todo1", runId, ordinal: 2, type: "todo_list", planId: "p1", steps };
}

function show(opts: { thread?: Partial<Thread>; runs?: Run[]; items?: TurnItem[] } = {}) {
  useThreadStore.setState({
    current: threadFromSnapshot(
      {
        sequence: 1,
        thread: threadFixture("t1", { capabilities: capabilitiesFor("claude"), ...opts.thread }),
        runs: opts.runs ?? [],
        items: opts.items ?? [],
        requests: [],
        queue: [],
        historyCursor: null,
      },
      false,
    ),
    missing: null,
  });
  return render(<ChatComposer threadId="t1" />);
}

const commands = (type: string) => posts.filter((p) => p.type === type);

describe("error banner (ThreadErrorBanner)", () => {
  it("shows the error the latest run ended on instead of the bare 'last run failed', and Dismiss sticks on this device", () => {
    const view = show({ runs: [failedRun], items: [errorItem("e1")] });
    const banner = screen.getByRole("alert");
    expect(within(banner).getByText("The last run failed")).toBeInTheDocument();
    expect(within(banner).getByText("API Error: Connection dropped (ECONNRESET)")).toBeInTheDocument();
    expect(screen.queryByText("The last run failed.")).toBeNull();
    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByText("API Error: Connection dropped (ECONNRESET)")).toBeNull();
    expect(JSON.parse(localStorage.getItem("sightr.v2.dismissedThreadErrors") ?? "[]")).toEqual(["t1\u0000e1"]);
    // A reload (the store re-read from storage) keeps it dismissed.
    view.unmount();
    __resetDismissedThreadErrors();
    show({ runs: [failedRun], items: [errorItem("e1")] });
    expect(screen.queryByText("API Error: Connection dropped (ECONNRESET)")).toBeNull();
  });

  it("a new error item brings the banner back", () => {
    localStorage.setItem("sightr.v2.dismissedThreadErrors", JSON.stringify(["t1\u0000e1"]));
    __resetDismissedThreadErrors();
    show({ runs: [failedRun], items: [errorItem("e2", { message: "Overloaded" })] });
    expect(screen.getByText("Overloaded")).toBeInTheDocument();
  });

  it("a long error is clamped and opens on tap (no hover tooltip on a phone)", () => {
    const long = `API Error: ${"x ".repeat(200)}`;
    show({ runs: [failedRun], items: [errorItem("e1", { message: long })] });
    const text = document.querySelector<HTMLButtonElement>("[data-thread-error-text]")!;
    expect(text).toHaveAttribute("aria-expanded", "false");
    expect(text.className).toContain("line-clamp-3");
    fireEvent.click(text);
    expect(text).toHaveAttribute("aria-expanded", "true");
    expect(text.className).not.toContain("line-clamp-3");
  });
});

describe("usage-limit banner (UsageLimitRecoveryBanner)", () => {
  it("names the reset time and snoozes the thread until it with thread.snooze", async () => {
    const resetAt = Date.now() + 3 * 3_600_000;
    show({ runs: [failedRun], items: [errorItem("e1", { class: "usage_limit", message: "You've hit your session limit · resets 11:30am", resetAt })] });
    const banner = screen.getByRole("alert");
    expect(within(banner).getByText(`Usage limit reached · ${usageLimitResetLabel(resetAt)}`)).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole("button", { name: "Snooze until reset" }));
    await waitFor(() => expect(commands("thread.snooze")).toHaveLength(1));
    expect(commands("thread.snooze")[0]).toMatchObject({ threadId: "t1", until: resetAt });
  });

  it("says 'Snoozed until reset' once the thread sleeps until then, and Dismiss hides it", () => {
    const resetAt = Date.now() + 3_600_000;
    show({
      thread: { shelf: "snoozed", snoozedUntil: resetAt },
      runs: [failedRun],
      items: [errorItem("e1", { class: "usage_limit", message: "limit", resetAt })],
    });
    expect(screen.getByText("Snoozed until reset")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Snooze until reset" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Usage limit reached/)).toBeNull();
  });

  it("without a reset time it says so and offers no snooze", () => {
    show({ runs: [failedRun], items: [errorItem("e1", { class: "usage_limit", message: "limit", resetAt: null })] });
    expect(screen.getByText("Usage limit reached")).toBeInTheDocument();
    expect(screen.getByText("Reset time unavailable; retry manually")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Snooze until reset" })).toBeNull();
  });

  it("formats the reset time like the snooze menu", () => {
    const now = new Date(2026, 9, 18, 9, 0);
    expect(usageLimitResetLabel(new Date(2026, 9, 18, 11, 30).getTime(), now)).toMatch(/^resets 11:30/);
    expect(usageLimitResetLabel(new Date(2026, 9, 19, 9, 0).getTime(), now)).toMatch(/^resets tomorrow 9:00/);
    expect(usageLimitResetLabel(null, now)).toBeNull();
  });
});

describe("context window meter (ContextWindowMeter)", () => {
  const meter = () => document.querySelector<HTMLButtonElement>('[data-composer-control="context-window"]');

  it("is hidden without Thread.contextUsage", () => {
    show();
    expect(meter()).toBeNull();
  });

  it("shows used/window on tap and Compact sends /compact as a normal message", async () => {
    show({ thread: { contextUsage: { usedTokens: 50_000, maxTokens: 200_000 } } });
    expect(meter()).toHaveAccessibleName("Context window 25% used");
    fireEvent.click(meter()!);
    const popup = await screen.findByLabelText("Context window", { selector: "[data-slot=popover-popup]" });
    expect(within(popup).getByText("50k/200k")).toBeInTheDocument();
    expect(within(popup).getByRole("progressbar", { name: "Context window usage" })).toHaveAttribute("aria-valuenow", "25");
    fireEvent.click(within(popup).getByRole("button", { name: "Compact context" }));
    await waitFor(() => expect(commands("message.dispatch")).toHaveLength(1));
    expect(commands("message.dispatch")[0]).toMatchObject({ threadId: "t1", text: "/compact", mode: "start" });
    expect(commands("message.dispatch")[0]).not.toHaveProperty("attachments");
  });

  it("without a known window it shows tokens only", async () => {
    show({ thread: { contextUsage: { usedTokens: 4_100 } } });
    expect(meter()).toHaveAccessibleName("Context window 4.1k tokens used");
    fireEvent.click(meter()!);
    const popup = await screen.findByLabelText("Context window", { selector: "[data-slot=popover-popup]" });
    expect(within(popup).getByText("4.1k tokens")).toBeInTheDocument();
    expect(within(popup).queryByRole("progressbar")).toBeNull();
  });

  it("Compact is disabled while the thread is working, and says why", async () => {
    show({ thread: { status: "working", contextUsage: { usedTokens: 50_000, maxTokens: 200_000 } } });
    fireEvent.click(meter()!);
    const popup = await screen.findByLabelText("Context window", { selector: "[data-slot=popover-popup]" });
    expect(within(popup).getByRole("button", { name: "Compact context" })).toBeDisabled();
    expect(within(popup).getByText("The agent is working. Compact when it stops.")).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });
});

describe("tasks badge (ComposerTasksBadge)", () => {
  const steps: PlanStep[] = [
    { id: "a", text: "Read the code", status: "completed" },
    { id: "b", text: "Write the fix", status: "running" },
    { id: "c", text: "Run the tests", status: "pending" },
  ];
  const running: Run = { id: "r1", threadId: "t1", ordinal: 1, status: "running", startedAt: 1_000 };

  it("shows done/total and the current step; a tap opens the checklist in a sheet", async () => {
    show({ thread: { status: "working" }, runs: [running], items: [todo(steps)] });
    const badge = document.querySelector<HTMLButtonElement>("[data-composer-tasks-badge]")!;
    expect(badge).toHaveAccessibleName("Tasks: 1 of 3 complete. Current task: Write the fix");
    expect(within(badge).getByText("1/3")).toBeInTheDocument();
    fireEvent.click(badge);
    const sheet = await screen.findByRole("dialog");
    const list = within(sheet).getByRole("list", { name: "Task list. 1 of 3 complete." });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-step-status"))).toEqual(["completed", "inProgress", "pending"]);
    expect(rows[1]).toHaveTextContent("Running: Write the fix");
  });

  it("is absent without a task list, and a finished list goes when its run ends", () => {
    show();
    expect(document.querySelector("[data-composer-tasks-badge]")).toBeNull();
    const done = steps.map((s) => ({ ...s, status: "completed" as const }));
    act(() => {
      useThreadStore.setState({
        current: threadFromSnapshot(
          { sequence: 2, thread: threadFixture("t1"), runs: [{ ...running, status: "completed", completedAt: 2_000 }], items: [todo(done)], requests: [], queue: [], historyCursor: null },
          false,
        ),
      });
    });
    expect(document.querySelector("[data-composer-tasks-badge]")).toBeNull();
  });
});
