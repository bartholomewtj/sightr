// T29 in the Diff tab: the "Comments N" button and the pending list that takes the panel's body, a comment made from a
// gutter tap, comments on a file the scope no longer lists, a read-only device, and a list row that scrolls to its line.
// The renderer is the real seam (the hand adapter); IntersectionObserver and ResizeObserver are inert stubs.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NO_CAPABILITIES } from "@shared/v2/contracts";
import { useDiffPanelStore } from "@/diffPanelStore";
import { useRightPanelStore } from "@/rightPanelStore";
import { getThreadComposer } from "@/state/composer";
import { addLineComment, getLineComments } from "@/state/lineComments";
import { threadFromSnapshot } from "@/stream/apply";
import { useBridgeInfo, useThreadStore } from "@/stream/stores";
import { createDiffServer } from "@/test/diffServer";
import { thread } from "@/test/fixtures";
import { edit, run as runItem, user } from "@/test/turn-items";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

import { DiffPanel } from "./DiffPanel";

let scrolledRows: string[] = [];

beforeEach(() => {
  class FakeIO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  class FakeRO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = FakeIO;
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = FakeRO;
  scrolledRows = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledRows.push((this as HTMLElement).dataset.newLine ? `new ${(this as HTMLElement).dataset.newLine}` : ((this as HTMLElement).dataset.diffFile ?? "?"));
  };
  setViewportWidth(390);
  const fake = createDiffServer([{ path: "src/a.ts" }, { path: "src/b.ts" }]);
  server.use(
    http.get("/api/files/pane-folder", () => HttpResponse.json({ path: "proj" })),
    http.get("/api/files/git", () => HttpResponse.json({ available: true, repo: "proj", rel: "", clean: false, entries: [], hidden: 0, statusTruncated: false, diff: "", diffTruncated: false, panes: [], rootPath: "proj" })),
    ...fake.handlers,
  );
  openThread();
});
afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
});

function openThread(canQueueDrain = true) {
  act(() =>
    useThreadStore.setState({
      current: threadFromSnapshot(
        { sequence: 1, thread: thread("t1", { paneId: "p-t1", capabilities: { ...NO_CAPABILITIES, canQueueDrain } }), runs: [], items: [], requests: [], queue: [], historyCursor: null },
        false,
      ),
      missing: null,
    }),
  );
}

const comment = (note: string, path = "src/a.ts", over: Partial<Parameters<typeof addLineComment>[1]> = {}) => {
  const r = addLineComment("t1", { path, side: "new", start: 2, end: 2, quote: ["+new 0"], note, ...over });
  if (!r.ok) throw new Error(r.reason);
  return r.comment;
};
const chip = () => document.querySelector<HTMLElement>("[data-diff-comments-chip]");
const list = () => document.querySelector<HTMLElement>("[data-diff-comments-list]");
const gutter = (path: string, side: "old" | "new", n: number) =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-diff-file="${path}"] [data-diff-gutter=${side}]`)).find((g) => g.textContent === String(n));

async function mount() {
  const view = render(<DiffPanel threadId="t1" />);
  await waitFor(() => expect(document.querySelectorAll("[data-diff-file]").length).toBeGreaterThan(0));
  await waitFor(() => expect(document.querySelector("[data-diff-adapter=hand] [data-diff-line]")).not.toBeNull()); // the lazy adapter, not the plain fallback
  return view;
}

describe("the Comments button and the list", () => {
  it("shows no button without comments, then Comments N once there are some", async () => {
    await mount();
    expect(chip()).toBeNull();
    act(() => void comment("one"));
    expect(chip()).toHaveTextContent("Comments 1");
  });

  it("opens the list in place of the files (no second sheet), and Files returns to them", async () => {
    comment("rename it");
    await mount();
    fireEvent.click(chip()!);
    expect(list()).not.toBeNull();
    expect(document.querySelector("[data-diff-file]")).toBeNull();
    expect(within(list()!).getByText("src/a.ts:2")).toBeInTheDocument();
    expect(within(list()!).getByText("rename it")).toBeInTheDocument();
    expect(within(list()!).getByLabelText("Quoted lines")).toHaveTextContent("+new 0");
    fireEvent.click(within(list()!).getByRole("button", { name: /Files/ }));
    expect(list()).toBeNull();
    expect(document.querySelector("[data-diff-file]")).not.toBeNull();
  });

  it("a comment made from a gutter tap appears on the button and in the list", async () => {
    await mount();
    fireEvent.click(gutter("src/a.ts", "new", 2)!);
    fireEvent.change(screen.getByRole("textbox", { name: /^Comment on/ }), { target: { value: "dictated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(chip()).toHaveTextContent("Comments 1");
    expect(getLineComments("t1")[0]).toMatchObject({ path: "src/a.ts", side: "new", start: 2, end: 2, quote: ["+new 0"], note: "dictated" });
  });

  it("marks a comment on a file the scope does not list as Outdated, and keeps it", async () => {
    comment("on a file that left", "src/gone.ts");
    await mount();
    await waitFor(() => expect(getLineComments("t1")[0]!.state).toBe("outdated"));
    fireEvent.click(chip()!);
    const row = list()!.querySelector("[data-comment]") as HTMLElement;
    expect(row).toHaveAttribute("data-comment-state", "outdated");
    expect(within(row).getByText("Outdated")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "src/gone.ts:2" })).toBeDisabled(); // not in the diff being shown
    expect(within(row).getByRole("button", { name: /Edit/ })).toBeDisabled();
  });

  it("anchors a comment when its file's diff loads, and marks it outdated when the lines differ", async () => {
    comment("matches", "src/a.ts"); // the fake patch has "+new" as new line 2
    comment("does not", "src/b.ts", { quote: ["+something else"] });
    await mount();
    await waitFor(() => expect(getLineComments("t1").map((c) => c.state)).toEqual(["pending", "outdated"]));
  });

  it("Add puts the block in the composer's queue of insertions; Add all leaves outdated comments out", async () => {
    const a = comment("one", "src/a.ts");
    comment("stale", "src/b.ts", { quote: ["+nope"] });
    await mount();
    await waitFor(() => expect(getLineComments("t1")[1]!.state).toBe("outdated"));
    fireEvent.click(chip()!);
    expect(list()).toHaveTextContent("Add all leaves out 1 outdated comment");
    act(() => useRightPanelStore.getState().openSheet("diff"));
    fireEvent.click(within(list()!).getByRole("button", { name: /Add all/ }));
    const ins = getThreadComposer("t1").insertion;
    expect(ins?.blocks).toHaveLength(1);
    expect(ins?.blocks[0]).toContain("[review] src/a.ts:2 (new)");
    expect(ins?.blocks[0]).toContain(a.note);
    expect(ins?.focus).toBe(false); // a phone: no focus
    expect(useRightPanelStore.getState().sheet).toBeNull(); // and the sheet closes
  });

  it("an outdated comment needs a confirm tap to be added, and then carries ', outdated' in its header", async () => {
    comment("stale", "src/b.ts", { quote: ["+nope"] });
    await mount();
    await waitFor(() => expect(getLineComments("t1")[0]!.state).toBe("outdated"));
    fireEvent.click(chip()!);
    fireEvent.click(within(list()!).getByRole("button", { name: "Add" }));
    expect(getThreadComposer("t1").insertion).toBeNull();
    expect(list()).toHaveTextContent("This code changed since you commented");
    fireEvent.click(within(list()!).getByRole("button", { name: "Add anyway" }));
    expect(getThreadComposer("t1").insertion?.blocks[0]).toContain("[review] src/b.ts:2 (new, outdated)");
  });

  it("Delete removes a comment and offers Undo for five seconds", async () => {
    comment("one");
    await mount();
    fireEvent.click(chip()!);
    fireEvent.click(within(list()!).getByRole("button", { name: /Delete/ }));
    expect(getLineComments("t1")).toHaveLength(0);
    const { useThreadUndoNotice, undoLatestThreadAction } = await import("@/hooks/showThreadUndoNotice");
    expect(useThreadUndoNotice.getState().notice?.action).toBe("Comment removed");
    act(() => void undoLatestThreadAction());
    await waitFor(() => expect(getLineComments("t1")).toHaveLength(1));
  });

  it("Discard all needs a second tap", async () => {
    comment("one");
    comment("two", "src/b.ts");
    await mount();
    fireEvent.click(chip()!);
    fireEvent.click(within(list()!).getByRole("button", { name: "Discard all" }));
    expect(getLineComments("t1")).toHaveLength(2);
    fireEvent.click(within(list()!).getByRole("button", { name: "Tap again to discard" }));
    expect(getLineComments("t1")).toHaveLength(0);
  });

  it("a shell thread keeps the list but turns Add off and says why", async () => {
    openThread(false);
    comment("one");
    await mount();
    fireEvent.click(chip()!);
    expect(list()).toHaveTextContent("This pane is a shell");
    expect(within(list()!).getByRole("button", { name: "Add" })).toBeDisabled();
    expect(within(list()!).getByRole("button", { name: /Add all/ })).toBeDisabled();
  });

  it("a row's path closes the list, opens the file and scrolls its line to the middle", async () => {
    comment("look here", "src/a.ts");
    await mount();
    fireEvent.click(chip()!);
    fireEvent.click(within(list()!).getByRole("button", { name: "src/a.ts:2" }));
    expect(list()).toBeNull();
    await waitFor(() => expect(scrolledRows).toContain("new 2"));
  });

  it("Edit is off on a read-only device, like Add", async () => {
    comment("look here", "src/a.ts");
    act(() => useBridgeInfo.setState({ readOnly: true }));
    await mount();
    fireEvent.click(chip()!);
    expect(within(list()!).getByRole("button", { name: /Edit/ })).toBeDisabled();
    expect(within(list()!).getByRole("button", { name: /Edit/ })).toHaveAttribute("title", expect.stringContaining("read-only"));
    expect(within(list()!).getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("Edit on a row opens the editor under its range with the note", async () => {
    comment("look here", "src/a.ts");
    await mount();
    fireEvent.click(chip()!);
    fireEvent.click(within(list()!).getByRole("button", { name: /Edit/ }));
    const box = await screen.findByRole("textbox", { name: /^Comment on/ });
    expect(box).toHaveValue("look here");
    expect(screen.getByText(/Editing the comment on new line 2/)).toBeInTheDocument();
  });
});

describe("when comments are off", () => {
  it("a read-only device sees no gutter buttons and is told why", async () => {
    act(() => useBridgeInfo.setState({ readOnly: true }));
    await mount();
    expect(document.querySelector("[data-diff-gutter]")).toBeNull();
    expect(document.querySelector("[data-diff-note=comments-off]")).toHaveTextContent("this device is read-only");
  });

  it("run scope: comments are off on a journal fragment (its lines count from 1) and stay on for a new file's real header", async () => {
    const inRun = { runId: "r1" };
    act(() =>
      useThreadStore.setState({
        current: threadFromSnapshot(
          {
            sequence: 1,
            thread: thread("t1", { paneId: "p-t1", capabilities: { ...NO_CAPABILITIES, canQueueDrain: true } }),
            runs: [runItem("r1")],
            items: [
              user("u:0", "go", inRun),
              edit("e:0", "src/a.ts", { ...inRun, additions: 1, deletions: 1, diffStr: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ @@\n ctx\n-x\n+y\n ctx2" }),
              edit("e:1", "docs/n.md", { ...inRun, additions: 2, deletions: 0, diffStr: "--- /dev/null\n+++ b/docs/n.md\n@@ -0,0 +1,2 @@\n+a\n+b" }),
            ],
            requests: [],
            queue: [],
            historyCursor: null,
          },
          false,
        ),
        missing: null,
      }),
    );
    act(() => useDiffPanelStore.getState().setScope("t1", { kind: "run", runId: "r1" }));
    render(<DiffPanel threadId="t1" />);
    await waitFor(() => expect(document.querySelector('[data-diff-file="docs/n.md"] [data-diff-gutter]')).not.toBeNull());
    expect(document.querySelector('[data-diff-file="docs/n.md"] [data-diff-commentable]')).toHaveAttribute("data-diff-comments", "on");
    const frag = document.querySelector('[data-diff-file="src/a.ts"] [data-diff-commentable]')!;
    expect(frag).toHaveAttribute("data-diff-comments", "off");
    expect(frag).toHaveTextContent("Comments need real line numbers; open Working tree.");
    expect(frag.querySelector("[data-diff-gutter]")).toBeNull();
  });

  it("a refused file in the list has no gutter and says why, and its neighbour keeps its gutter", async () => {
    server.use(...createDiffServer([{ path: ".env" }, { path: "src/ok.ts" }]).handlers);
    await mount();
    await waitFor(() => expect(document.querySelectorAll("[data-diff-adapter=hand]").length).toBeGreaterThan(1));
    expect(document.querySelector('[data-diff-file=".env"] [data-diff-gutter]')).toBeNull();
    expect(document.querySelector('[data-diff-file=".env"] [data-diff-comments-off]')).toHaveTextContent(/refusal list/);
    expect(document.querySelector('[data-diff-file="src/ok.ts"] [data-diff-gutter]')).not.toBeNull();
  });
});
