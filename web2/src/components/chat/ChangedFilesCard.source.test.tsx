// T31: the changed-files card reads the run's checkpoint when it has a ready one (badge "Exact") and the journal when it
// does not ("From agent edits"), through the real timeline. The badge opens the sheet, Back closes it, a source flip keeps
// what the reader had folded.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CheckpointFile, Run, RunCheckpoint, TurnItem } from "@shared/v2/contracts";

import { applyThreadEvent, threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { __resetChangedFilesView } from "./AssistantChangedFilesSection";
import { __resetTimelineState } from "@/state/timeline";
import { __resetSheetHistory } from "../sheetHistory";
import { thread as threadFixture } from "@/test/fixtures";
import { installListLayout } from "@/test/list-layout";
import { assistant, edit, resetOrdinals, run, user } from "@/test/turn-items";

import { MessagesTimeline } from "./MessagesTimeline";

beforeEach(() => {
  resetOrdinals();
  installListLayout();
  __resetTimelineState();
  __resetChangedFilesView();
  __resetSheetHistory();
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function settle(ms = 50) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const inRun = { runId: "r1" };
const diffOf = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ @@\n-x\n+y`;
const FIVE = ["src/a.ts", "src/b.ts", "lib/c.ts", "lib/d.ts", "README.md"];

function journalItems(paths: string[] = FIVE): TurnItem[] {
  return [
    user("u:0", "go", inRun),
    ...paths.map((p, i) => edit(`e:${i}`, p, { ...inRun, additions: 1, deletions: 1, diffStr: diffOf(p) })),
    assistant("m:0", "Done.", inRun),
  ];
}

const file = (path: string, over: Partial<CheckpointFile> = {}): CheckpointFile => ({ path, kind: "modified", additions: 4, deletions: 2, authored: true, ...over });
const cp = (over: Partial<RunCheckpoint> = {}): RunCheckpoint => ({
  runId: "r1",
  threadId: "t1",
  appRunOrdinal: 0,
  status: "ready",
  live: true,
  files: FIVE.map((p) => file(p)),
  additions: 20,
  deletions: 10,
  ...over,
});

async function show(items: TurnItem[], runs: Run[]) {
  useThreadStore.setState({
    current: threadFromSnapshot(
      {
        sequence: 1,
        thread: threadFixture("t1", { paneId: "pane-1", capabilities: { ...threadFixture("t1").capabilities, hasJournal: true } }),
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
  const view = render(<MessagesTimeline threadId="t1" />);
  await settle();
  return view;
}

const card = () => document.querySelector("[data-changed-files]") as HTMLElement | null;
const badge = () => card()!.querySelector("[data-source-badge]") as HTMLElement;
const sheet = () => document.querySelector("[data-source-sheet-popup]") as HTMLElement | null;

describe("the source badge on the card", () => {
  it("reads From agent edits for a run with no checkpoint", async () => {
    await show(journalItems(), [run("r1")]);
    expect(within(card()!).getByText("From agent edits")).toBeTruthy();
    expect(badge().getAttribute("data-source-badge")).toBe("journal");
    expect(card()!.getAttribute("data-changed-files-source")).toBe("journal");
  });

  it("reads Exact, with the checkpoint's own counts and a shell tag, for a ready checkpoint", async () => {
    const files = [...FIVE.map((p) => file(p)), file("gen/out.ts", { authored: false, kind: "added" })];
    await show(journalItems(), [run("r1", { checkpoint: cp({ files, additions: 24, deletions: 12 }) })]);
    const c = card()!;
    expect(within(c).getByText("Exact")).toBeTruthy();
    expect(within(c).getByText("Changed files (6)")).toBeTruthy();
    expect(within(c).getByRole("group", { name: "24 additions, 12 deletions" })).toBeTruthy();
    expect(c.querySelector('[data-changed-file="gen/out.ts"] [data-mark="shell"]')).toBeTruthy();
    expect(c.querySelector('[data-changed-file="src/a.ts"] [data-mark="shell"]')).toBeNull();
    expect(c.querySelector("[data-changed-files-caveat]")).toBeNull();
  });

  it("draws a card for a run only its checkpoint knows (a shell-made change)", async () => {
    await show(
      [user("u:0", "go", inRun), assistant("m:0", "Ran sed.", inRun)],
      [run("r1", { checkpoint: cp({ files: [file("src/a.ts", { authored: false })], additions: 4, deletions: 2 }) })],
    );
    expect(within(card()!).getByText("Changed files (1)")).toBeTruthy();
    expect(card()!.querySelector('[data-changed-file="src/a.ts"] [data-mark="shell"]')).toBeTruthy();
  });

  it("draws no card for a ready checkpoint with no net change and no journal edit", async () => {
    await show([user("u:0", "hi", inRun), assistant("m:0", "Hello.", inRun)], [run("r1", { checkpoint: cp({ files: [], additions: 0, deletions: 0 }) })]);
    expect(card()).toBeNull();
  });

  it("says why the journal is shown, in the sheet, when the snapshot is absent", async () => {
    await show(journalItems(), [run("r1", { checkpoint: cp({ status: "absent", reason: "no-repo", files: [], additions: 0, deletions: 0 }) })]);
    expect(within(card()!).getByText("From agent edits")).toBeTruthy();
    fireEvent.click(badge());
    await settle();
    expect(within(sheet()!).getByText("This folder isn't a git repository.")).toBeTruthy();
  });

  it("labels a working run's journal list Run in progress", async () => {
    await show(journalItems(), [run("r1", { status: "running", completedAt: undefined, checkpoint: cp({ status: "pending", files: [], additions: 0, deletions: 0 }) })]);
    expect(within(card()!).getByText("Run in progress")).toBeTruthy();
    expect(within(card()!).getByText("From agent edits")).toBeTruthy();
  });
});

describe("the sheet", () => {
  const popped = () => new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));

  it("opens from the badge with both paragraphs and closes with its button", async () => {
    await show(journalItems(), [run("r1", { checkpoint: cp() })]);
    expect(sheet()).toBeNull();
    fireEvent.click(badge());
    await settle();
    const s = sheet()!;
    expect(within(s).getByText(/^Exact: compared with a snapshot of the folder when the run started and when it ended\./)).toBeTruthy();
    expect(within(s).getByText(/^From agent edits: what the agent's edit tools reported\./)).toBeTruthy();

    const stepped = popped(); // closing by hand takes the sheet's history entry back off
    fireEvent.click(within(s).getByRole("button", { name: "Close" }));
    await stepped;
    await waitFor(() => expect(sheet()).toBeNull());
  });

  it("closes on Back, one history step", async () => {
    await show(journalItems(), [run("r1", { checkpoint: cp() })]);
    fireEvent.click(badge());
    await settle();
    expect(sheet()).not.toBeNull();
    expect((window.history.state as Record<string, unknown> | null)?.sightrSheet).toBe(true);
    const stepped = popped();
    await act(async () => {
      window.history.back();
    });
    await stepped;
    await waitFor(() => expect(sheet()).toBeNull());
  });
});

describe("the footers", () => {
  it("names the edits the run undid, dimmed, behind 'N edited and reverted'", async () => {
    const items = journalItems([...FIVE, "src/undone.ts"]);
    await show(items, [run("r1", { checkpoint: cp() })]);
    const c = card()!;
    const toggle = within(c).getByRole("button", { name: /1 edited and reverted/ });
    expect(c.querySelector("[data-reverted-names]")).toBeNull();
    fireEvent.click(toggle);
    expect(within(c.querySelector("[data-reverted-names]") as HTMLElement).getByText("src/undone.ts")).toBeTruthy();
    expect(within(c).getByText("Changed files (5)")).toBeTruthy();
  });

  it("renders an absolute reverted journal path repo-relative", async () => {
    const abs = ["/work/repo/src/a.ts", "/work/repo/src/b.ts", "/work/repo/lib/c.ts", "/work/repo/lib/d.ts", "/work/repo/README.md", "/work/repo/src/undone.ts"];
    await show(journalItems(abs), [run("r1", { checkpoint: cp() })]);
    const c = card()!;
    fireEvent.click(within(c).getByRole("button", { name: /1 edited and reverted/ }));
    const names = c.querySelector("[data-reverted-names]") as HTMLElement;
    expect(within(names).getByText("src/undone.ts")).toBeTruthy();
    expect(names.textContent).not.toMatch(/\/work\/repo/);
  });

  it("says No net changes, and how many files the agent edited, when the folder ended as it started", async () => {
    await show(journalItems(["src/a.ts", "src/b.ts"]), [run("r1", { checkpoint: cp({ files: [], additions: 0, deletions: 0 }) })]);
    const c = card()!;
    expect(within(c).getByText("No net changes")).toBeTruthy();
    expect(within(c).getByText(/The agent edited 2 files; the folder ended as it started\./)).toBeTruthy();
    expect(within(c).getByText("Exact")).toBeTruthy();
  });

  it("carries the snapshot's flags and the files it could not show", async () => {
    await show(journalItems(), [run("r1", { checkpoint: cp({ shared: true, approximate: true, unsettled: true, hidden: 1, skipped: 1, truncated: true }) })]);
    const c = card()!;
    expect(within(c).getByText("Another thread was working in this folder, so its edits may be included.")).toBeTruthy();
    expect(within(c).getByText("Start snapshot was taken late; earlier edits may be missing.")).toBeTruthy();
    expect(within(c).getByText("Files were still changing when the snapshot was taken.")).toBeTruthy();
    expect(within(c).getByText("2 files not shown")).toBeTruthy();
    expect(within(c).getByText("Showing the first 5 files. The counts include every file.")).toBeTruthy();
  });
});

describe("a source flip", () => {
  it("keeps the folders the reader folded when the end snapshot arrives", async () => {
    await show(journalItems(), [run("r1", { status: "running", completedAt: undefined })]);
    expect(within(card()!).getByText("From agent edits")).toBeTruthy();
    fireEvent.click(within(card()!).getByRole("button", { name: "Collapse all" }));
    expect(card()!.querySelector('[data-changed-file="src/a.ts"]')).toBeNull();

    const current = useThreadStore.getState().current!;
    const started = applyThreadEvent(current, { sequence: 2, threadId: "t1", type: "run.ended", payload: { runId: "r1", status: "completed", completedAt: 9_000 }, ts: 9_000 });
    const flipped = applyThreadEvent(started, { sequence: 3, threadId: "t1", type: "checkpoint.captured", payload: { checkpoint: cp({ capturedAt: 9_100 }), phase: "end" }, ts: 9_100 });
    await act(async () => {
      useThreadStore.setState({ current: flipped });
    });
    await settle();

    const c = card()!;
    expect(within(c).getByText("Exact")).toBeTruthy();
    expect(c.querySelector('[data-changed-file="src/a.ts"]')).toBeNull(); // still folded
    expect(within(c).getByRole("button", { name: "Expand all" })).toBeTruthy();
    expect(c.querySelector("[data-changed-dir]")).toBeTruthy();
    expect(screen.queryByText("Run in progress")).toBeNull();
  });

  it("drops to the journal when a pending checkpoint outlives its 10 s", async () => {
    // 600 ms of the grace are left when the card mounts.
    const completedAt = Date.now() - 9_400;
    await show(journalItems(), [run("r1", { startedAt: completedAt - 5_000, completedAt, checkpoint: cp({ status: "pending", files: [], additions: 0, deletions: 0 }) })]);
    expect(within(card()!).getByText("Finishing snapshot")).toBeTruthy();
    await waitFor(() => expect(within(card()!).queryByText("Finishing snapshot")).toBeNull(), { timeout: 4_000 });
    expect(within(card()!).getByText("From agent edits")).toBeTruthy();
    expect(card()!.getAttribute("data-changed-files-state")).toBe("fallback");
  });
});
