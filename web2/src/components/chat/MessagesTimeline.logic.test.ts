import { beforeEach, describe, expect, it } from "vitest";

import type { Run, TurnItem } from "@shared/v2/contracts";

import { deriveTimelineEntries, type WorkLogEntry } from "~/session-logic";
import { assistant, command, edit, read, reasoning, resetOrdinals, run, screen, session, user } from "@/test/turn-items";

import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  insertDayDividers,
  resolveTimelineIsAtEnd,
  workEntryDisplayLabel,
  type MessagesTimelineRow,
  type MessagesTimelineRowsInput,
} from "./MessagesTimeline.logic";

beforeEach(() => resetOrdinals());

function rowsFor(items: TurnItem[], runs: Run[] = [], over: Partial<MessagesTimelineRowsInput> = {}): MessagesTimelineRow[] {
  const latest = runs.at(-1);
  const running = runs.find((r) => r.status === "running");
  return deriveMessagesTimelineRows({
    timelineEntries: deriveTimelineEntries({ items, runs }),
    latestRun: latest ? { runId: latest.id, status: latest.status, startedAt: latest.startedAt, completedAt: latest.completedAt } : null,
    runningRunId: running?.id ?? null,
    runs,
    isWorking: running !== undefined,
    activeTurnStartedAt: running?.startedAt ?? null,
    ...over,
  });
}

const kinds = (rows: MessagesTimelineRow[]) => rows.map((r) => r.kind);
const R = "r1";
const inRun = { runId: R };
/** Expanded so the run's work is not folded under "Worked for …". */
const open = { expandedRunIds: new Set([R]) };

describe("deriveMessagesTimelineRows (T3 row model on Sightr items)", () => {
  it("groups consecutive tools into one toggle row", () => {
    const rows = rowsFor(
      [user("u:0", "go", inRun), command("a:0", "ls", inRun), command("b:0", "pwd", inRun), command("c:0", "whoami", inRun), assistant("d:0", "done", inRun)],
      [run(R)],
      open,
    );
    const toggle = rows.find((r) => r.kind === "work-toggle");
    expect(toggle).toMatchObject({ summary: "Ran 3 commands", hiddenCount: 3, expanded: false });
    expect(rows.filter((r) => r.kind === "work-toggle")).toHaveLength(1);
  });

  it("splits groups at a message between tools", () => {
    const rows = rowsFor(
      [user("u:0", "go", inRun), command("a:0", "ls", inRun), command("b:0", "pwd", inRun), assistant("m:0", "halfway", inRun), command("c:0", "x", inRun), command("d:0", "y", inRun), assistant("e:0", "done", inRun)],
      [run(R)],
      open,
    );
    expect(rows.filter((r) => r.kind === "work-toggle")).toHaveLength(2);
    expect(kinds(rows)).toEqual(["message", "turn-fold", "work-toggle", "message", "work-toggle", "message"]);
  });

  it("shows a single tool as a one-line row, not a group", () => {
    const rows = rowsFor([user("u:0", "go", inRun), command("a:0", "npm test", inRun), assistant("b:0", "ok", inRun)], [run(R)], open);
    const work = rows.find((r) => r.kind === "work");
    expect(work).toMatchObject({ kind: "work", displayLabel: "npm test", isExpandedToolGroup: false });
    expect(rows.some((r) => r.kind === "work-toggle")).toBe(false);
  });

  it("labels a mixed group with T3's summary (two leading actions, then the rest)", () => {
    const rows = rowsFor(
      [
        user("u:0", "go", inRun),
        command("a:0", "ls", inRun),
        read("b:0", "src/a.ts", inRun),
        edit("c:0", "src/a.ts", inRun),
        read("d:0", "src/b.ts", inRun),
        command("e:0", "bun test", inRun),
        read("f:0", "src/c.ts", inRun),
        assistant("g:0", "done", inRun),
      ],
      [run(R)],
      open,
    );
    const toggle = rows.find((r) => r.kind === "work-toggle");
    expect(toggle && toggle.kind === "work-toggle" && toggle.summary).toBe("Ran 2 commands, changed 1 file, and performed 3 other actions");
    expect(toggle && toggle.kind === "work-toggle" && toggle.summaryKind).toBe("mixed");
  });

  it("names a single read and a read-only group by their files", () => {
    const one = rowsFor([user("u:0", "go", inRun), read("a:0", "src/a.ts", inRun), assistant("b:0", "ok", inRun)], [run(R)], open);
    expect(one.find((r) => r.kind === "work")).toMatchObject({ displayLabel: "Read src/a.ts" });
    resetOrdinals();
    const many = rowsFor(
      [user("u:0", "go", inRun), read("a:0", "a.ts", inRun), read("b:0", "b.ts", inRun), assistant("c:0", "ok", inRun)],
      [run(R)],
      open,
    );
    expect(many.find((r) => r.kind === "work-toggle")).toMatchObject({ summary: "Read 2 files", summaryKind: "read" });
  });

  it("folds a settled run's work under 'Worked for …' and keeps its last reply", () => {
    const rows = rowsFor(
      [user("u:0", "go", inRun), command("a:0", "ls", inRun), command("b:0", "pwd", inRun), assistant("c:0", "done", inRun)],
      [run(R, { startedAt: 1_000_000, completedAt: 1_063_000 })],
    );
    expect(kinds(rows)).toEqual(["message", "turn-fold", "message"]);
    expect(rows[1]).toMatchObject({ label: "Worked for 1m 3s", expanded: false });
  });

  it("inserts a day divider when the calendar day changes", () => {
    const day1 = new Date(2026, 9, 14, 23, 50).getTime();
    const day2 = new Date(2026, 9, 15, 0, 10).getTime();
    const rows = rowsFor([user("u:0", "late", { createdAt: day1 }), user("v:0", "early", { createdAt: day2 })], [], {
      now: new Date(2026, 9, 16, 9, 0).getTime(),
    });
    expect(kinds(rows)).toEqual(["message", "day", "message"]);
    expect(rows[1]).toMatchObject({ kind: "day", label: "Yesterday", id: "day:2026-10-15" });
  });

  it("keeps no divider before the first row or within one day", () => {
    const now = new Date(2026, 9, 16, 9, 0).getTime();
    const rows = insertDayDividers(
      rowsFor([user("u:0", "a", { createdAt: now - 60_000 }), user("v:0", "b", { createdAt: now })]),
      now,
    );
    expect(kinds(rows)).toEqual(["message", "message"]);
  });

  it("never repeats a day when a row's clock runs behind the one before it", () => {
    const now = new Date(2026, 9, 16, 9, 0).getTime();
    const yesterday = now - 24 * 60 * 60_000;
    const rows = insertDayDividers(
      rowsFor([
        user("u:0", "a", { createdAt: yesterday }),
        user("v:0", "b", { createdAt: now }),
        user("w:0", "skewed", { createdAt: yesterday + 1_000 }),
        user("x:0", "c", { createdAt: now + 1_000 }),
      ]),
      now,
    );
    expect(kinds(rows)).toEqual(["message", "day", "message", "message", "message"]);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders a session change and a screen capture as event rows", () => {
    const rows = rowsFor([user("u:0", "go"), session("s:0"), screen("x:0", "$ ls\nfile")]);
    expect(rows.filter((r) => r.kind === "event").map((r) => (r.kind === "event" ? r.projectedItem.type : null))).toEqual([
      "session",
      "screen",
    ]);
  });

  it("adds the working header and the live tail only while a run is running", () => {
    const live = rowsFor([user("u:0", "go", inRun)], [run(R, { status: "running", completedAt: undefined })]);
    expect(kinds(live)).toEqual(["message", "working", "thinking"]);
    expect(live[1]).toMatchObject({ createdAt: 1_000_000 });
    resetOrdinals();
    const done = rowsFor([user("u:0", "go", inRun), assistant("a:0", "ok", inRun)], [run(R)]);
    expect(kinds(done)).not.toContain("working");
    expect(kinds(done)).not.toContain("thinking");
  });

  it("shows a running tool as the live row, never folded", () => {
    const rows = rowsFor(
      [user("u:0", "go", inRun), command("a:0", "ls", inRun), command("b:0", "npm test", { ...inRun, status: "running" })],
      [run(R, { status: "running", completedAt: undefined })],
    );
    const liveRow = rows.find((r) => r.kind === "work-live");
    expect(liveRow).toMatchObject({ active: true, expanded: false });
    expect(liveRow && liveRow.kind === "work-live" && liveRow.entry.command).toBe("npm test");
    expect(kinds(rows)).not.toContain("turn-fold");
  });

  it("adds a 'Stopped' notice after an interrupted run and an error after a failed one", () => {
    const stopped = rowsFor([user("u:0", "go", inRun), assistant("a:0", "partial", inRun)], [run(R, { status: "interrupted" })]);
    const notice = stopped.find((r) => r.kind === "work" && r.groupedEntries[0]?.itemType === "system_notice");
    expect(notice && notice.kind === "work" && notice.groupedEntries[0]?.label).toBe("Stopped");
    resetOrdinals();
    const failed = rowsFor([user("u:0", "go", inRun), command("a:0", "ls", inRun)], [run(R, { status: "failed" })]);
    const error = failed.find((r) => r.kind === "work" && r.groupedEntries[0]?.itemType === "error");
    expect(error).toBeDefined();
    expect(kinds(failed)).not.toContain("turn-fold");
  });

  it("puts reasoning in the work log, labelled with its duration", () => {
    const rows = rowsFor(
      [user("u:0", "go", { ...inRun, createdAt: 1_000_000 }), reasoning("t:0", "Let me think.", { ...inRun, createdAt: 1_000_000 }), command("c:0", "ls", { ...inRun, createdAt: 1_012_000 }), assistant("d:0", "ok", inRun)],
      [run(R)],
      open,
    );
    const toggle = rows.find((r) => r.kind === "work-toggle");
    expect(toggle && toggle.kind === "work-toggle" && toggle.summary).toBe("Ran 1 command");
    const details = deriveTimelineEntries({ items: [reasoning("t:0", "x", { ...inRun, createdAt: 0 }), command("c:0", "ls", { ...inRun, createdAt: 12_000 })], runs: [] });
    expect(details[0]?.kind === "work" && details[0].entry.reasoningTime).toBe(12_000);
  });
});

describe("the changed-files row (T24)", () => {
  const change = (id: string, file: string, over: Record<string, unknown> = {}) =>
    edit(id, file, { ...inRun, additions: 2, deletions: 1, ...over });
  const cardOf = (rows: MessagesTimelineRow[]) => rows.find((r) => r.kind === "changed-files");

  it("follows the run's last assistant message", () => {
    const rows = rowsFor(
      [user("u:0", "go", inRun), change("e:0", "a.ts"), assistant("m:0", "first", inRun), assistant("n:0", "done", inRun)],
      [run(R)],
      open,
    );
    const index = rows.findIndex((r) => r.kind === "changed-files");
    expect(rows[index - 1]).toMatchObject({ kind: "message", id: "n:0" });
    expect(cardOf(rows)).toMatchObject({ id: "changed-files:r1", runId: R, summary: { files: 1, additions: 2, deletions: 1 } });
  });

  it("follows assistant-meta when trailing tool groups moved it", () => {
    const rows = rowsFor(
      [user("u:0", "go", inRun), change("e:0", "a.ts"), assistant("m:0", "done", inRun), command("c:0", "ls", inRun), command("d:0", "pwd", inRun)],
      [run(R)],
      open,
    );
    const ids = rows.map((r) => r.id);
    const meta = ids.indexOf("assistant-meta:m:0");
    expect(meta).toBeGreaterThan(-1);
    expect(ids.indexOf("changed-files:r1")).toBe(meta + 1);
  });

  it("stays when the run is folded and its work rows hide", () => {
    const rows = rowsFor([user("u:0", "go", inRun), change("e:0", "a.ts"), command("c:0", "ls", inRun), assistant("m:0", "done", inRun)], [run(R)]);
    expect(kinds(rows)).toEqual(["message", "turn-fold", "message", "changed-files"]);
    expect(rows.some((r) => r.kind === "work" || r.kind === "work-toggle")).toBe(false);
  });

  it("is absent for a run without edits", () => {
    const rows = rowsFor([user("u:0", "go", inRun), command("c:0", "ls", inRun), assistant("m:0", "done", inRun)], [run(R)], open);
    expect(cardOf(rows)).toBeUndefined();
  });

  it("is present, with 'No files changed' data, for a run whose edits all failed", () => {
    const rows = rowsFor(
      [user("u:0", "go", inRun), change("e:0", "a.ts", { status: "failed", errorText: "nope" }), assistant("m:0", "could not", inRun)],
      [run(R)],
      open,
    );
    expect(cardOf(rows)).toMatchObject({ summary: { files: 0, failedEdits: 1 } });
  });

  it("anchors after the last work row for a run with no reply", () => {
    const rows = rowsFor([user("u:0", "go", inRun), change("e:0", "a.ts"), command("c:0", "ls", inRun)], [run(R, { status: "interrupted" })], open);
    const last = rows.findLastIndex((r) => r.kind === "work" || r.kind === "work-toggle");
    expect(last).toBeGreaterThan(-1);
    expect(rows.findIndex((r) => r.kind === "changed-files")).toBe(last + 1);
  });

  it("anchors after the fold row when everything is folded and there is no reply", () => {
    const rows = rowsFor([user("u:0", "go", inRun), change("e:0", "a.ts"), command("c:0", "ls", inRun)], [run(R)]);
    expect(kinds(rows)).toEqual(["message", "turn-fold", "changed-files"]);
  });

  it("is not part of a work-log group, so it does not break a continuing work log", () => {
    const rows = rowsFor(
      [user("u:0", "go", inRun), command("a:0", "ls", inRun), command("b:0", "pwd", inRun), assistant("m:0", "mid", inRun), change("e:0", "a.ts"), command("c:0", "x", inRun), command("d:0", "y", inRun)],
      [run(R, { status: "interrupted" })],
      open,
    );
    expect(cardOf(rows)).toBeDefined();
    const card = cardOf(rows)!;
    expect("continuesWorkLog" in card && card.continuesWorkLog).toBeFalsy();
    const toggles = rows.filter((r) => r.kind === "work-toggle");
    expect(toggles).toHaveLength(2);
  });

  it("keeps its id while a running run's counts change, and a newer message moves it down", () => {
    const live = run(R, { status: "running", completedAt: undefined });
    const base = [user("u:0", "go", inRun), change("e:0", "a.ts"), assistant("m:0", "working on it", inRun)];
    const first = rowsFor(base, [live]);
    const second = rowsFor([...base, change("f:0", "b.ts"), assistant("n:0", "more", inRun)], [live]);
    expect(cardOf(first)!.id).toBe("changed-files:r1");
    expect(cardOf(second)!.id).toBe("changed-files:r1");
    expect(cardOf(second)).toMatchObject({ summary: { files: 2 } });
    expect(second[second.findIndex((r) => r.kind === "changed-files") - 1]).toMatchObject({ id: "n:0" });
  });

  it("uses the anchor's time, so it never starts a day", () => {
    const rows = rowsFor([user("u:0", "go", { ...inRun, createdAt: 1_000_000 }), change("e:0", "a.ts"), assistant("m:0", "done", { ...inRun, createdAt: 1_000_500 })], [run(R)], { ...open, now: 1_001_000 });
    expect(rows.filter((r) => r.kind === "day")).toHaveLength(0);
    expect(cardOf(rows)!.createdAt).toBe(1_000_500);
  });

  it("is replaced when its counts change and kept when an unrelated item changes", () => {
    const base = [user("u:0", "go", inRun), change("e:0", "a.ts"), assistant("m:0", "done", inRun)];
    const first = computeStableMessagesTimelineRows(rowsFor(base, [run(R)], open), { byId: new Map(), result: [] });
    const unrelated = computeStableMessagesTimelineRows(rowsFor([...base, read("r:0", "x.ts", inRun)], [run(R)], open), first);
    expect(unrelated.byId.get("changed-files:r1")).toBe(first.byId.get("changed-files:r1"));
    const counted = computeStableMessagesTimelineRows(rowsFor([base[0]!, change("e:0", "a.ts", { additions: 9 }), base[2]!], [run(R)], open), unrelated);
    expect(counted.byId.get("changed-files:r1")).not.toBe(first.byId.get("changed-files:r1"));
  });
});

describe("computeStableMessagesTimelineRows", () => {
  it("keeps row objects whose item did not change, and replaces the one that did", () => {
    const a = command("a:0", "ls", inRun);
    const items = [user("u:0", "go", inRun), a, assistant("b:0", "ok", inRun)];
    const first = computeStableMessagesTimelineRows(rowsFor(items, [run(R)], open), { byId: new Map(), result: [] });
    const again = computeStableMessagesTimelineRows(rowsFor([...items], [run(R)], open), first);
    expect(again).toBe(first);
    const changed = computeStableMessagesTimelineRows(
      rowsFor([items[0]!, { ...a, status: "failed" } as TurnItem, items[2]!], [run(R)], open),
      again,
    );
    expect(changed.result[0]).toBe(first.result[0]);
    expect(changed.result.find((r) => r.id === "a:0")).not.toBe(first.result.find((r) => r.id === "a:0"));
  });
});

describe("resolveTimelineIsAtEnd", () => {
  it("re-arms follow within 80 px of the end", () => {
    expect(resolveTimelineIsAtEnd({ contentLength: 1000, scroll: 330, scrollLength: 600 })).toBe(true);
    expect(resolveTimelineIsAtEnd({ contentLength: 1000, scroll: 300, scrollLength: 600 })).toBe(false);
    expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined();
  });
});

describe("commandPreview (the live row's command)", () => {
  it("keeps the first 40 characters on one line, with an ellipsis when cut", async () => {
    const { commandPreview } = await import("./MessagesTimeline.logic");
    expect(commandPreview("git status")).toBe("git status");
    expect(commandPreview("for i in $(seq 1 60); do echo tick $i; sleep 1; done")).toBe("for i in $(seq 1 60); do echo tick $i; s…");
    expect(commandPreview("cat <<EOF\nhello\nEOF")).toBe("cat <<EOF hello EOF");
    expect(commandPreview("  ")).toBe("");
  });
});

describe("workEntryDisplayLabel for approval_request", () => {
  it("prefers subject title + detail when detail is present", () => {
    const entry = {
      id: "req1",
      createdAt: 1000,
      runId: "r1",
      tone: "tool" as const,
      itemType: "approval_request" as const,
      label: "Approval requested",
      projectedItem: {
        id: "req1",
        threadId: "t1",
        runId: "r1",
        status: "completed" as const,
        type: "approval_request" as const,
        requestId: "r1",
        requestKind: "permission" as const,
        prompt: "Do you want to proceed?",
        subject: {
          title: "Run command",
          target: "cd C:/bench && gh pr merge 1144",
          detail: "Record the review, merge PR 1144, remove the 7e worktree",
        },
      },
    };
    expect(workEntryDisplayLabel(entry as unknown as WorkLogEntry, undefined)).toBe(
      "Run command · Record the review, merge PR 1144, remove the 7e worktree",
    );
  });

  it("shows subject title + command target preview when no detail is present", () => {
    const entry = {
      id: "req2",
      createdAt: 1000,
      runId: "r1",
      tone: "tool" as const,
      itemType: "approval_request" as const,
      label: "Approval requested",
      projectedItem: {
        id: "req2",
        threadId: "t1",
        runId: "r1",
        status: "completed" as const,
        type: "approval_request" as const,
        requestId: "r2",
        requestKind: "permission" as const,
        prompt: "Do you want to proceed?",
        subject: {
          title: "Bash command",
          target: "git branch -D strip/7e-css",
        },
      },
    };
    expect(workEntryDisplayLabel(entry as unknown as WorkLogEntry, undefined)).toBe(
      "Bash command · git branch -D strip/7e-css",
    );
  });

  it("falls back to entry.label or 'Approval requested' instead of 'Do you want to proceed?' when no subject is present", () => {
    const entry = {
      id: "req3",
      createdAt: 1000,
      runId: "r1",
      tone: "tool" as const,
      itemType: "approval_request" as const,
      label: "Approval requested",
      detail: "Do you want to proceed?",
      projectedItem: {
        id: "req3",
        threadId: "t1",
        runId: "r1",
        status: "waiting" as const,
        type: "approval_request" as const,
        requestId: "r3",
        requestKind: "permission" as const,
        prompt: "Do you want to proceed?",
      },
    };
    expect(workEntryDisplayLabel(entry as unknown as WorkLogEntry, undefined)).toBe("Approval requested");
  });
});
