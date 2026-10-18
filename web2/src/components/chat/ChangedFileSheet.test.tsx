// The changed-files card under a run's reply, through the real timeline, and the sheet a tap opens.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Run, TurnItem } from "@shared/v2/contracts";

import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { __resetTimelineState } from "@/state/timeline";
import { thread as threadFixture } from "@/test/fixtures";
import { installListLayout } from "@/test/list-layout";
import { assistant, edit, resetOrdinals, run, user } from "@/test/turn-items";

import { openPrintedPath } from "../right-panel/OpenFileLink";
import { closeChangedFile } from "./changedFilesTarget";
import { MessagesTimeline } from "./MessagesTimeline";

vi.mock("../right-panel/OpenFileLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../right-panel/OpenFileLink")>()),
  openPrintedPath: vi.fn(async () => true),
}));

beforeEach(() => {
  resetOrdinals();
  installListLayout();
  __resetTimelineState();
  closeChangedFile();
  vi.mocked(openPrintedPath).mockClear();
});
afterEach(() => {
  closeChangedFile();
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

const inRun = { runId: "r1" };
const diffA = (n: number) => `--- a/src/a.ts\n+++ b/src/a.ts\n@@ @@\n-before${n}\n+after${n}`;

function threeEdits(): TurnItem[] {
  return [
    user("u:0", "go", inRun),
    edit("e:0", "src/a.ts", { ...inRun, additions: 1, deletions: 1, diffStr: diffA(1) }),
    edit("e:1", "src/a.ts", { ...inRun, status: "failed", errorText: "String to replace not found in file", diffStr: diffA(2) }),
    edit("e:2", "src/a.ts", { ...inRun, additions: 1, deletions: 1, diffStr: diffA(3) }),
    assistant("m:0", "Edited it.", inRun),
  ];
}

const card = () => document.querySelector("[data-changed-files]") as HTMLElement | null;
const sheet = () => document.querySelector("[data-changed-file-sheet]") as HTMLElement | null;

describe("changed-files card in the timeline", () => {
  it("sits under the reply with the file's summed counts and a new mark", async () => {
    await show(
      [
        user("u:0", "go", inRun),
        edit("e:0", "src/new.ts", { ...inRun, additions: 3, deletions: 0, diffStr: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,3 @@\n+a\n+b\n+c" }),
        edit("e:1", "src/old.ts", { ...inRun, additions: 1, deletions: 1, diffStr: diffA(1) }),
        edit("e:2", "src/old.ts", { ...inRun, additions: 2, deletions: 0, diffStr: diffA(2) }),
        assistant("m:0", "All done.", inRun),
      ],
      [run("r1")],
    );
    const c = card()!;
    expect(c).toBeTruthy();
    expect(within(c).getByText("Changed files (2)")).toBeTruthy();
    const timeline = [...document.querySelectorAll("[data-timeline-row-kind]")].map((el) => el.getAttribute("data-timeline-row-kind"));
    expect(timeline.at(-1)).toBe("changed-files");
    expect(timeline.at(-2)).toBe("message");
    expect(c.querySelector('[data-changed-file="src/new.ts"] [data-mark="new"]')).toBeTruthy();
    expect(within(c.querySelector('[data-changed-file="src/old.ts"]') as HTMLElement).getByRole("group", { name: "3 additions, 1 deletions" })).toBeTruthy();
    expect(within(c).getByText(/Counts add up each edit/)).toBeTruthy();
  });

  it("stays when the run is folded", async () => {
    await show(threeEdits(), [run("r1")]);
    expect(screen.getByRole("button", { name: /Worked for/ })).toBeTruthy();
    expect(card()).toBeTruthy();
  });
});

describe("ChangedFileSheet", () => {
  async function openSheet() {
    await show(threeEdits(), [run("r1")]);
    fireEvent.click(card()!.querySelector('[data-changed-file="src/a.ts"]')!);
    await settle();
    expect(sheet()).toBeTruthy();
    return sheet()!;
  }

  it("lists the file's edits in order, each with its number and status", async () => {
    const s = await openSheet();
    expect(within(s).getByText("Edit 1 of 3")).toBeTruthy();
    expect(within(s).getByText("Edit 2 of 3")).toBeTruthy();
    expect(within(s).getByText("Edit 3 of 3")).toBeTruthy();
    const edits = [...s.querySelectorAll("[data-changed-file-edit]")];
    expect(edits.map((el) => el.getAttribute("data-changed-file-edit"))).toEqual(["e:0", "e:1", "e:2"]);
    expect(edits.map((el) => el.getAttribute("data-edit-status"))).toEqual(["completed", "failed", "completed"]);
    expect(edits[0]!.textContent).toContain("after1");
    expect(edits[2]!.textContent).toContain("after3");
    expect(s.querySelector("[data-changed-file-path]")!.textContent).toBe("src/a.ts");
  });

  it("shows a failed edit's own error and says there is no net diff for a file edited twice", async () => {
    const s = await openSheet();
    const failed = s.querySelector('[data-changed-file-edit="e:1"]') as HTMLElement;
    expect(within(failed).getByLabelText("Error").textContent).toBe("String to replace not found in file");
    expect(within(s).getByText(/no single diff for the file/)).toBeTruthy();
  });

  it("says nothing about a net diff for a file edited once", async () => {
    await show([user("u:0", "go", inRun), edit("e:0", "b.ts", { ...inRun, additions: 1, deletions: 0, diffStr: diffA(1) }), assistant("m:0", "ok", inRun)], [run("r1")]);
    fireEvent.click(card()!.querySelector('[data-changed-file="b.ts"]')!);
    await settle();
    expect(within(sheet()!).getByText("Edit 1 of 1")).toBeTruthy();
    expect(sheet()!.querySelector('[data-changed-file-note="net"]')).toBeNull();
  });

  it("opens the file in Files from the top button, closing the sheet first", async () => {
    const s = await openSheet();
    fireEvent.click(within(s).getByRole("button", { name: "Open file" }));
    expect(openPrintedPath).toHaveBeenCalledWith("t1", "pane-1", "src/a.ts");
    await waitFor(() => expect(sheet()).toBeNull(), { timeout: 2000 });
  });

  it("closes with the close button", async () => {
    const s = await openSheet();
    fireEvent.click(within(s).getByRole("button", { name: "Close changed file" }));
    await waitFor(() => expect(sheet()).toBeNull(), { timeout: 2000 });
  });

  it("closes with Back, once, and stays on the page", async () => {
    await openSheet();
    expect((window.history.state as Record<string, unknown> | null)?.sightrSheet).toBe(true);
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(sheet()).toBeNull(), { timeout: 2000 });
    expect((window.history.state as Record<string, unknown> | null)?.sightrSheet).toBeFalsy();
  });

  it("is unmounted when closed", async () => {
    await show(threeEdits(), [run("r1")]);
    expect(sheet()).toBeNull();
    expect(document.querySelector("[data-changed-file-body]")).toBeNull();
  });
});
