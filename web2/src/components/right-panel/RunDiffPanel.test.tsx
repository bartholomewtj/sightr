// T31: the Diff panel's run scope reads the run's checkpoint (the file list is on the run; only patches are fetched, by
// T30's `scope=run` route) and falls back to the journal. Against a fake of that route (msw) and the thread store.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { CheckpointFile, Run, RunCheckpoint, ThreadEvent, TurnItem } from "@shared/v2/contracts";
import { REVIEW_PATHS } from "@shared/v2/review";

import { useDiffPanelStore } from "@/diffPanelStore";
import { applyThreadEvent, threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { drawWindows, mountPanel, scrolled, section, sections, settle, useDiffPanelHarness } from "@/test/diffPanelHarness";
import { fakePatch } from "@/test/diffServer";
import { thread } from "@/test/fixtures";
import { server } from "@/test/setup";
import { edit, run as runOf, user } from "@/test/turn-items";

import { DiffPanel } from "../DiffPanel";

useDiffPanelHarness([]);

const file = (path: string, over: Partial<CheckpointFile> = {}): CheckpointFile => ({ path, kind: "modified", additions: 1, deletions: 1, authored: true, ...over });
const cp = (runId: string, over: Partial<RunCheckpoint> = {}): RunCheckpoint => ({
  runId,
  threadId: "t1",
  appRunOrdinal: 1,
  status: "ready",
  live: true,
  files: [file("src/a.ts"), file("src/b.ts")],
  additions: 2,
  deletions: 2,
  capturedAt: 5_000,
  ...over,
});
const done = (id: string, ordinal: number, checkpoint?: RunCheckpoint): Run => runOf(id, { ordinal, ...(checkpoint ? { checkpoint } : {}) });

// ── the fake of T30's run route ──
let patchCalls: URL[] = [];
let contentsCalls: URL[] = [];
let failPatch = 0;
let stored = new Set<string>();

beforeEach(() => {
  patchCalls = [];
  contentsCalls = [];
  failPatch = 0;
  stored = new Set();
  server.use(
    http.get(REVIEW_PATHS.patch, ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get("scope") !== "run") return undefined;
      patchCalls.push(url);
      if (failPatch > 0) {
        failPatch -= 1;
        return new HttpResponse("boom", { status: 500 });
      }
      const path = url.searchParams.get("file") ?? "";
      const w = url.searchParams.get("w");
      if (w === "1" && stored.has("expired")) return HttpResponse.json({ available: false, reason: "expired" });
      return HttpResponse.json({ available: true, patch: fakePatch(path, `old w${w}`, `new w${w}`), truncated: false, diffHash: `r-${path}-${w}` });
    }),
    http.get(REVIEW_PATHS.contents, ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get("scope") !== "run") return undefined;
      contentsCalls.push(url);
      return HttpResponse.json({ available: true, old: { state: "text", text: "a\nb\nc\n", crlf: false }, new: { state: "text", text: "a\nB\nc\n", crlf: false }, diffHash: "c" });
    }),
  );
});

function open(runs: Run[], items: TurnItem[] = [], over: Parameters<typeof thread>[1] = {}) {
  act(() =>
    useThreadStore.setState({
      current: threadFromSnapshot({ sequence: 1, thread: thread("t1", { paneId: "p-t1", ...over }), runs, items, requests: [], queue: [], historyCursor: null }, false),
      missing: null,
    }),
  );
}
function apply(event: Omit<ThreadEvent, "sequence" | "ts"> & { sequence?: number }) {
  act(() => {
    const current = useThreadStore.getState().current!;
    useThreadStore.setState({ current: applyThreadEvent(current, { ts: 9_000, sequence: current.sequence + 1, ...event } as ThreadEvent) });
  });
}
const showRun = (runId: string) => act(() => useDiffPanelStore.getState().setScope("t1", { kind: "run", runId }));
const badge = () => document.querySelector("[data-source-badge]") as HTMLElement | null;
const note = (name: string) => document.querySelector(`[data-diff-note=${name}]`) as HTMLElement | null;
const stateOf = (path: string) => section(path)?.getAttribute("data-diff-state");
const wsButton = () => screen.getByRole("button", { name: "Ignore whitespace" });
const diffOf = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ @@\n-x\n+y`;
const journalEdits = (runId: string, paths: string[]) => [user("u:0", "go", { runId }), ...paths.map((p, i) => edit(`e:${i}`, p, { runId, additions: 1, deletions: 1, diffStr: diffOf(p) }))];

describe("the run scope from a checkpoint", () => {
  it("lists the run's files from the run and asks only for patches, by run and file, with no folder", async () => {
    open([done("r1", 1, cp("r1", { files: [file("src/a.ts"), file("gen/out.ts", { authored: false, kind: "added" })] }))]);
    showRun("r1");
    await mountPanel();
    expect(sections().map((s) => s.dataset.diffFile).sort()).toEqual(["gen/out.ts", "src/a.ts"]);
    await waitFor(() => expect(stateOf("src/a.ts")).toBe("ready"));
    await waitFor(() => expect(stateOf("gen/out.ts")).toBe("ready"));
    expect(patchCalls.map((u) => u.searchParams.get("file")).sort()).toEqual(["gen/out.ts", "src/a.ts"]);
    const q = patchCalls[0]!.searchParams;
    expect([q.get("scope"), q.get("threadId"), q.get("runId"), q.get("w"), q.has("path")]).toEqual(["run", "t1", "r1", "0", false]);
    expect(badge()).toHaveAttribute("data-source-badge", "checkpoint");
    expect(within(badge()!).getByText("Exact")).toBeTruthy();
    expect(within(section("gen/out.ts")).getByText("shell")).toBeTruthy();
    expect(within(section("src/a.ts")).queryByText("shell")).toBeNull();
    expect(note("run")).toBeNull(); // no "from the agent's edits" caveat on an exact list
  });

  it("says No net changes, and how many files the agent edited, for an empty net diff", async () => {
    open([done("r1", 1, cp("r1", { files: [], additions: 0, deletions: 0 }))], journalEdits("r1", ["src/a.ts", "src/b.ts"]));
    showRun("r1");
    render(<DiffPanel threadId="t1" />);
    expect(await screen.findByText("No net changes. The agent edited 2 files; the folder ended as it started.")).toBeInTheDocument();
    expect(badge()).toHaveAttribute("data-source-badge", "checkpoint");
    expect(patchCalls).toHaveLength(0);
  });

  it("names the snapshot's caveats under the list", async () => {
    open([done("r1", 1, cp("r1", { shared: true, approximate: true, unsettled: true, hidden: 1, skipped: 2 }))], journalEdits("r1", ["src/a.ts", "src/b.ts", "src/undone.ts"]));
    showRun("r1");
    await mountPanel();
    const notes = document.querySelector("[data-snapshot-notes]") as HTMLElement;
    expect(within(notes).getByText("Another thread was working in this folder, so its edits may be included.")).toBeTruthy();
    expect(within(notes).getByText("Start snapshot was taken late; earlier edits may be missing.")).toBeTruthy();
    expect(within(notes).getByText("Files were still changing when the snapshot was taken.")).toBeTruthy();
    expect(within(notes).getByText("3 files not shown")).toBeTruthy();
  });

  it("names the edits the run undid behind 'N edited and reverted'", async () => {
    open([done("r1", 1, cp("r1"))], journalEdits("r1", ["src/a.ts", "src/b.ts", "src/undone.ts"]));
    showRun("r1");
    await mountPanel();
    fireEvent.click(screen.getByRole("button", { name: /1 edited and reverted/ }));
    expect(within(document.querySelector("[data-reverted-names]") as HTMLElement).getByText("src/undone.ts")).toBeTruthy();
  });
});

describe("the run picker", () => {
  const three = () => [done("r1", 1, cp("r1", { files: [file("one.ts")] })), done("r2", 2, cp("r2", { files: [file("two.ts")] })), done("r3", 3, cp("r3", { files: [file("three.ts")] }))];

  it("steps through the runs that changed something, oldest to newest, and stops at the ends", async () => {
    open(three());
    showRun("r3");
    await mountPanel();
    const label = () => document.querySelector("[data-run-picker-label]")?.textContent ?? "";
    expect(label()).toMatch(/^Run 3 of 3 · \d/);
    expect(screen.getByRole("button", { name: "Next run" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
    await waitFor(() => expect(useDiffPanelStore.getState().scopes["t1"]).toEqual({ kind: "run", runId: "r2" }));
    await waitFor(() => expect(sections().map((s) => s.dataset.diffFile)).toEqual(["two.ts"]));
    expect(label()).toMatch(/^Run 2 of 3 · /);
    fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
    await waitFor(() => expect(sections().map((s) => s.dataset.diffFile)).toEqual(["one.ts"]));
    expect(screen.getByRole("button", { name: "Previous run" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next run" }));
    await waitFor(() => expect(sections().map((s) => s.dataset.diffFile)).toEqual(["two.ts"]));
  });

  it("skips a run that changed nothing", async () => {
    open([...three(), done("r4", 4, cp("r4", { files: [], additions: 0, deletions: 0 }))]);
    showRun("r3");
    await mountPanel();
    expect(document.querySelector("[data-run-picker-label]")?.textContent).toMatch(/^Run 3 of 3/);
  });

  it("opens on the run the card names, with the file revealed", async () => {
    open(three());
    act(() => useDiffPanelStore.getState().openDiffForRun("t1", "r2", "two.ts"));
    await mountPanel();
    await waitFor(() => expect(scrolled).toEqual(["two.ts"]));
    expect(section("two.ts").querySelector("h3 button[aria-expanded]")).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector("[data-run-picker-label]")?.textContent).toMatch(/^Run 2 of 3/);
  });
});

describe("a run in progress, then ending", () => {
  it("shows the journal under a strip, then the exact diff once the snapshot lands", async () => {
    open([runOf("r1", { ordinal: 1, status: "running", completedAt: undefined, checkpoint: cp("r1", { status: "pending", files: [], additions: 0, deletions: 0 }) })], journalEdits("r1", ["src/a.ts"]));
    showRun("r1");
    await mountPanel();
    expect(document.querySelector("[data-diff-note=run-running]")).toHaveTextContent("Run in progress. The exact diff appears when it ends.");
    expect(within(badge()!).getByText("From agent edits")).toBeTruthy();
    expect(sections().map((s) => s.dataset.diffFile)).toEqual(["src/a.ts"]);
    expect(patchCalls).toHaveLength(0); // the journal needs no fetch

    toggleOpen("src/a.ts"); // the reader has the file open
    apply({ threadId: "t1", type: "run.ended", payload: { runId: "r1", status: "completed", completedAt: 9_000 } });
    apply({ threadId: "t1", type: "checkpoint.captured", payload: { checkpoint: cp("r1", { files: [file("src/a.ts"), file("src/b.ts")] }), phase: "end" } });
    await waitFor(() => expect(within(badge()!).getByText("Exact")).toBeTruthy());
    expect(note("run-running")).toBeNull();
    expect(sections().map((s) => s.dataset.diffFile)).toEqual(["src/a.ts", "src/b.ts"]);
    await waitFor(() => expect(patchCalls.map((u) => u.searchParams.get("file"))).toContain("src/a.ts"));
    // The file the reader had open stays open across the flip.
    expect(section("src/a.ts").querySelector("h3 button[aria-expanded]")).toHaveAttribute("aria-expanded", "true");
  });

  it("says the snapshot is being finished for a run that just ended", async () => {
    const completedAt = Date.now() - 1_000;
    open([runOf("r1", { ordinal: 1, completedAt, checkpoint: cp("r1", { status: "pending", files: [], additions: 0, deletions: 0 }) })], journalEdits("r1", ["src/a.ts"]));
    showRun("r1");
    await mountPanel();
    expect(note("run-running")).toHaveTextContent("Finishing snapshot");
  });
});

function toggleOpen(path: string) {
  const button = section(path).querySelector("h3 button[aria-expanded]") as HTMLButtonElement;
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
}

describe("when the exact diff cannot be loaded", () => {
  it("falls back to the journal with a line and Retry, never a blank panel", async () => {
    open([done("r1", 1, cp("r1", { files: [file("src/a.ts")], additions: 1, deletions: 1 }))], journalEdits("r1", ["src/a.ts"]));
    failPatch = 1;
    showRun("r1");
    await mountPanel();
    await waitFor(() => expect(note("load-failed")).not.toBeNull());
    expect(note("load-failed")).toHaveTextContent("Couldn't load the exact diff");
    expect(within(badge()!).getByText("From agent edits")).toBeTruthy(); // Exact only for data that loaded
    expect(sections().map((s) => s.dataset.diffFile)).toEqual(["src/a.ts"]);

    fireEvent.click(within(note("load-failed")!).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(note("load-failed")).toBeNull());
    await waitFor(() => expect(within(badge()!).getByText("Exact")).toBeTruthy());
    await waitFor(() => expect(stateOf("src/a.ts")).toBe("ready"));
    expect(patchCalls).toHaveLength(2);
  });
});

describe("when the exact diff cannot be loaded and the journal has nothing", () => {
  it("still says so with Retry, and does not call the list Exact", async () => {
    open([done("r1", 1, cp("r1", { files: [file("gen/out.ts", { authored: false })], additions: 1, deletions: 1 }))]); // a shell-made change: no journal item
    failPatch = 1;
    showRun("r1");
    await mountPanel();
    await waitFor(() => expect(note("load-failed")).not.toBeNull());
    expect(note("load-failed")).toHaveTextContent("Couldn't load the exact diff");
    expect(note("load-failed")).not.toHaveTextContent("agent's edits");
    expect(within(badge()!).getByText("From agent edits")).toBeTruthy();
    expect(within(badge()!).queryByText("Exact")).toBeNull();
    expect(sections().map((s) => s.dataset.diffFile)).toEqual(["gen/out.ts"]);

    fireEvent.click(within(note("load-failed")!).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(note("load-failed")).toBeNull());
    await waitFor(() => expect(within(badge()!).getByText("Exact")).toBeTruthy());
    await waitFor(() => expect(stateOf("gen/out.ts")).toBe("ready"));
  });
});

describe("neither source", () => {
  it("says there are no recorded changes for a run with no checkpoint and no journal edit", async () => {
    open([done("r1", 1, cp("r1", { status: "absent", reason: "no-repo", files: [], additions: 0, deletions: 0 }))], [user("u:0", "hi", { runId: "r1" })]);
    showRun("r1");
    render(<DiffPanel threadId="t1" />);
    expect(await screen.findByText("No recorded changes for this run.")).toBeInTheDocument();
    expect(badge()).toBeNull();
  });
});

describe("expiry", () => {
  it("turns off Ignore whitespace and unchanged lines, and the stored patches still load", async () => {
    open([done("r1", 1, cp("r1", { files: ["a", "b", "c", "d"].map((n) => file(`src/${n}.ts`)) }))]);
    showRun("r1");
    await mountPanel();
    await settle();
    expect(patchCalls).toHaveLength(0); // more than 3 files start folded
    expect(wsButton()).not.toBeDisabled();

    fireEvent.click(wsButton());
    toggleOpen("src/a.ts");
    await waitFor(() => expect(patchCalls.some((u) => u.searchParams.get("w") === "1")).toBe(true));

    stored.add("expired"); // the host now answers `expired` for live reads
    apply({ threadId: "t1", type: "checkpoint.expired", payload: { runId: "r1" } });
    await waitFor(() => expect(wsButton()).toBeDisabled());
    expect(wsButton()).toHaveAttribute("title", "No longer available for this run");
    expect(note("expired")).toHaveTextContent("No longer available for this run");
    expect(within(badge()!).getByText("Exact")).toBeTruthy(); // still ready, list and patches stay

    const before = patchCalls.length;
    toggleOpen("src/d.ts");
    await waitFor(() => expect(patchCalls.length).toBeGreaterThan(before));
    expect(patchCalls.at(-1)!.searchParams.get("w")).toBe("0");
    await waitFor(() => expect(stateOf("src/d.ts")).toBe("ready"));
  });

  it("an archived thread loads a stored patch by thread and run, with no pane and no folder", async () => {
    let paneFolderCalls = 0;
    server.use(http.get("/api/files/pane-folder", () => {
      paneFolderCalls += 1;
      return HttpResponse.json({ path: null });
    }));
    open([done("r1", 1, cp("r1", { live: false, files: [file("src/a.ts")], additions: 1, deletions: 1 }))], [], { paneId: "", shelf: "archived", archivedAt: 1, archiveReason: "closed" } as never);
    showRun("r1");
    await mountPanel();
    await waitFor(() => expect(stateOf("src/a.ts")).toBe("ready"));
    expect(patchCalls).toHaveLength(1);
    expect([patchCalls[0]!.searchParams.get("threadId"), patchCalls[0]!.searchParams.get("runId"), patchCalls[0]!.searchParams.get("w"), patchCalls[0]!.searchParams.has("path")]).toEqual(["t1", "r1", "0", false]);
    expect(wsButton()).toBeDisabled();
    expect(paneFolderCalls).toBe(0);
  });
});

describe("expand unchanged lines for a live run", () => {
  const OLD = Array.from({ length: 60 }, (_, i) => `const v${i + 1} = ${i + 1};`);
  const PATCH = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,5 +1,5 @@", ` ${OLD[0]}`, ` ${OLD[1]}`, `-${OLD[2]}`, "+const v3 = 'three';", ` ${OLD[3]}`, ` ${OLD[4]}`, "@@ -50,5 +50,5 @@", ` ${OLD[49]}`, ` ${OLD[50]}`, `-${OLD[51]}`, "+const v52 = 'x';", ` ${OLD[52]}`, ` ${OLD[53]}`, ""].join("\n");

  it("reads the whole file from the run route, by thread and run", async () => {
    server.use(
      http.get(REVIEW_PATHS.patch, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("scope") !== "run") return undefined;
        patchCalls.push(url);
        return HttpResponse.json({ available: true, patch: PATCH, truncated: false, diffHash: "p" });
      }),
    );
    open([done("r1", 1, cp("r1", { files: [file("src/a.ts")], additions: 2, deletions: 2 }))]);
    showRun("r1");
    await mountPanel();
    await waitFor(() => expect(section("src/a.ts").querySelector("[data-diff-adapter] [data-diff-line]")).not.toBeNull());
    drawWindows();
    const showAll = Array.from(section("src/a.ts").querySelectorAll<HTMLElement>("[data-diff-expand]")).find((b) => /^Show all/.test(b.textContent ?? ""))!;
    expect(contentsCalls).toHaveLength(0);
    await act(async () => {
      fireEvent.click(showAll);
    });
    await waitFor(() => expect(contentsCalls).toHaveLength(1));
    const q = contentsCalls[0]!.searchParams;
    expect([q.get("scope"), q.get("threadId"), q.get("runId"), q.get("file"), q.has("path")]).toEqual(["run", "t1", "r1", "src/a.ts", false]);
  });

  it("offers no unchanged-line controls once the snapshot is gone", async () => {
    server.use(
      http.get(REVIEW_PATHS.patch, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("scope") !== "run") return undefined;
        return HttpResponse.json({ available: true, patch: PATCH, truncated: false, diffHash: "p" });
      }),
    );
    open([done("r1", 1, cp("r1", { live: false, files: [file("src/a.ts")], additions: 2, deletions: 2 }))]);
    showRun("r1");
    await mountPanel();
    await waitFor(() => expect(section("src/a.ts").querySelector("[data-diff-adapter] [data-diff-line]")).not.toBeNull());
    drawWindows();
    expect(section("src/a.ts").querySelector("[data-diff-expand]")).toBeNull();
  });
});
