// The changed-files card under a run's reply, through the real timeline, and where a tap on a file goes (the Diff tab, T27).
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Run, TurnItem } from "@shared/v2/contracts";

import { useDiffPanelStore } from "@/diffPanelStore";
import { useRightPanelStore } from "@/rightPanelStore";
import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { __resetTimelineState } from "@/state/timeline";
import { thread as threadFixture } from "@/test/fixtures";
import { installListLayout } from "@/test/list-layout";
import { assistant, edit, resetOrdinals, run, user } from "@/test/turn-items";

import { openChangedFile } from "./changedFilesTarget";
import { MessagesTimeline } from "./MessagesTimeline";

beforeEach(() => {
  resetOrdinals();
  installListLayout();
  __resetTimelineState();
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

describe("a tap on a file in the card", () => {
  it("opens the Diff tab on that run, at that file", async () => {
    await show(threeEdits(), [run("r1")]);
    fireEvent.click(card()!.querySelector('[data-changed-file="src/a.ts"]')!);
    await settle();
    expect(useDiffPanelStore.getState().scopes["t1"]).toEqual({ kind: "run", runId: "r1" });
    expect(useDiffPanelStore.getState().reveal).toMatchObject({ threadId: "t1", filePath: "src/a.ts" });
    expect(useRightPanelStore.getState().sheet).toBe("diff"); // a phone-width test: the sheet
  });

  it("opens no sheet of its own over the timeline (T24's changed-file sheet is gone)", async () => {
    await show(threeEdits(), [run("r1")]);
    fireEvent.click(card()!.querySelector('[data-changed-file="src/a.ts"]')!);
    await settle();
    expect(document.querySelector("[data-changed-file-sheet]")).toBeNull();
  });

  it("openChangedFile asks the diff store for the run's scope", () => {
    openChangedFile({ threadId: "t9", runId: "r9", path: "x/y.ts" });
    expect(useDiffPanelStore.getState().scopes["t9"]).toEqual({ kind: "run", runId: "r9" });
  });
});
