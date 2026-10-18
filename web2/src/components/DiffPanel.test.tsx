// The Diff tab against a fake of T26's API (src/test/diffServer.ts) and the thread store: scopes, the lazy
// per-file patches, the fold and reveal behaviour, refresh, and the two layouts. The renderer is the real
// seam (the hand adapter, lazily imported); IntersectionObserver and ResizeObserver are stubs the tests move.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Run, TurnItem } from "@shared/v2/contracts";
import { useDiffPanelStore, WORKING_TREE } from "@/diffPanelStore";
import { useRightPanelStore } from "@/rightPanelStore";
import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { createDiffServer, fakePatch, type DiffServer } from "@/test/diffServer";
import { thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";
import { assistant, edit, resetOrdinals, run as runItem, user } from "@/test/turn-items";

import { DiffPanel } from "./DiffPanel";
import { preloadDiffRenderer } from "./diffs/DiffCodeView";
import { diffMemoryKey, readDiffMemory, writeDiffMemory } from "./diffs/diffPanelMemory";

vi.mock("./diffs/DiffCodeView", async (importOriginal) => {
  const original = await importOriginal<typeof import("./diffs/DiffCodeView")>();
  return { ...original, preloadDiffRenderer: vi.fn(original.preloadDiffRenderer) };
});

// ── observers the tests can move ──
type IoEntry = { target: Element; isIntersecting: boolean };
let ios: Array<{ cb: (entries: IoEntry[]) => void; root: Element | null; observed: Set<Element> }> = [];
let ros: Array<{ cb: (entries: Array<{ contentRect: { width: number } }>) => void }> = [];

function installObservers() {
  ios = [];
  ros = [];
  class FakeIO {
    private rec: (typeof ios)[number];
    constructor(cb: (entries: IoEntry[]) => void, opts?: { root?: Element | null }) {
      this.rec = { cb, root: opts?.root ?? null, observed: new Set() };
      ios.push(this.rec);
    }
    observe(el: Element) {
      this.rec.observed.add(el);
    }
    unobserve(el: Element) {
      this.rec.observed.delete(el);
    }
    disconnect() {
      this.rec.observed.clear();
    }
    takeRecords() {
      return [];
    }
  }
  class FakeRO {
    constructor(cb: (entries: Array<{ contentRect: { width: number } }>) => void) {
      ros.push({ cb });
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = FakeIO;
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = FakeRO;
}
/** Tell the panel's scroller that these file headers are (now) within reach. */
function near(...paths: string[]) {
  const scrollerObs = ios.filter((io) => [...io.observed].some((el) => (el as HTMLElement).dataset.diffFile !== undefined));
  act(() => {
    for (const io of scrollerObs) {
      io.cb([...io.observed].filter((el) => paths.includes((el as HTMLElement).dataset.diffFile ?? "")).map((target) => ({ target, isIntersecting: true })));
    }
  });
}
/** The renderer draws a file's first window at once only for the first or the revealed file; any other open file draws it when it nears the screen. */
function drawWindows() {
  act(() => {
    for (const io of ios) {
      const els = [...io.observed].filter((el) => el.hasAttribute("data-diff-window"));
      if (els.length > 0) io.cb(els.map((target) => ({ target, isIntersecting: true })));
    }
  });
}
function resizePanel(width: number) {
  act(() => {
    for (const r of ros) r.cb([{ contentRect: { width } }]);
  });
}

// ── fixtures ──
let fake: DiffServer;
let rootPathCalls = 0;
const scrolled: string[] = [];

function openThread(items: TurnItem[] = [], runs: Run[] = []) {
  act(() =>
    useThreadStore.setState({
      current: threadFromSnapshot(
        { sequence: 1, thread: thread("t1", { paneId: "p-t1" }), runs, items, requests: [], queue: [], historyCursor: null },
        false,
      ),
      missing: null,
    }),
  );
}

beforeEach(() => {
  resetOrdinals();
  installObservers();
  fake = createDiffServer([{ path: "src/a.ts" }, { path: "src/b.ts" }]);
  rootPathCalls = 0;
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push((this as HTMLElement).dataset.diffFile ?? "?");
  };
  server.use(
    http.get("/api/files/pane-folder", () => HttpResponse.json({ path: "proj" })),
    http.get("/api/files/git", () => {
      rootPathCalls += 1;
      return HttpResponse.json({ available: true, repo: "proj", rel: "", clean: false, entries: [], hidden: 0, statusTruncated: false, diff: "", diffTruncated: false, panes: [], rootPath: "proj" });
    }),
    ...fake.handlers,
  );
  openThread();
});
afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
});

const sections = () => [...document.querySelectorAll<HTMLElement>("[data-diff-file]")];
const section = (path: string) => sections().find((s) => s.dataset.diffFile === path) as HTMLElement;
/** The button that folds and unfolds a file (not its Copy and Open buttons). */
const toggle = (path: string) => section(path).querySelector<HTMLButtonElement>("h3 button[aria-expanded]") as HTMLButtonElement;
const lines = (path: string) => section(path).querySelectorAll("[data-diff-line]");
const settle = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function mount(threadId = "t1") {
  const view = render(<DiffPanel threadId={threadId} />);
  await waitFor(() => expect(sections().length + (document.querySelector("[data-diff-message]") ? 1 : 0)).toBeGreaterThan(0));
  return view;
}

describe("DiffPanel: working tree", () => {
  it("lists the changed files, unfolds them when there are 3 or fewer, and fetches only those patches", async () => {
    await mount();
    expect(sections().map((s) => s.dataset.diffFile)).toEqual(["src/a.ts", "src/b.ts"]);
    await waitFor(() => expect(lines("src/a.ts").length).toBeGreaterThan(0));
    await waitFor(() => expect(lines("src/b.ts").length).toBeGreaterThan(0));
    expect(fake.patchPaths().sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(fake.listCalls[0]?.searchParams.get("path")).toBe("proj");
    expect(fake.listCalls[0]?.searchParams.get("scope")).toBe("working-tree");
    expect(screen.getByRole("tree", { name: "Changed files" })).toBeInTheDocument();
    // The status chip says the kind in words for a screen reader.
    expect(within(section("src/a.ts")).getByText("modified")).toBeInTheDocument();
  });

  it("shows the file count and the +/- in a header that folds the tree on a phone", async () => {
    await mount();
    const toggleBtn = document.querySelector<HTMLButtonElement>("[data-diff-tree-toggle]")!;
    expect(toggleBtn).toHaveTextContent("Files · 2");
    expect(toggleBtn).toHaveAttribute("aria-expanded", "true"); // open on the first visit
    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("tree")).toBeNull();
    fireEvent.click(toggleBtn);
    expect(screen.getByRole("tree")).toBeInTheDocument();
  });

  it("starts with every file folded when there are more than 3, and fetches nothing for them", async () => {
    fake.files = Array.from({ length: 5 }, (_, i) => ({ path: `src/f${i}.ts` }));
    await mount();
    expect(sections()).toHaveLength(5);
    expect(sections().every((s) => within(s).getAllByRole("button")[0]!.getAttribute("aria-expanded") === "false")).toBe(true);
    await settle();
    expect(fake.patchCalls).toHaveLength(0);
    // Unfolding one fetches it, and only it.
    fireEvent.click(toggle("src/f2.ts"));
    await waitFor(() => expect(section("src/f2.ts").querySelector("[data-diff-window]")).not.toBeNull());
    expect(fake.patchPaths()).toEqual(["src/f2.ts"]);
    // Not the first file, not revealed: its first window waits for the screen.
    expect(section("src/f2.ts").querySelector("[data-diff-window]")).toHaveAttribute("data-diff-window", "off");
    expect(lines("src/f2.ts")).toHaveLength(0);
    drawWindows();
    await waitFor(() => expect(lines("src/f2.ts").length).toBeGreaterThan(0));
  });

  it("fetches a folded file whose header comes near the screen", async () => {
    fake.files = Array.from({ length: 5 }, (_, i) => ({ path: `src/f${i}.ts` }));
    await mount();
    near("src/f3.ts");
    await waitFor(() => expect(fake.patchPaths()).toEqual(["src/f3.ts"]));
    // Fetched ahead, but still folded: no diff on screen.
    expect(lines("src/f3.ts")).toHaveLength(0);
    fireEvent.click(toggle("src/f3.ts"));
    await waitFor(() => expect(section("src/f3.ts").querySelector("[data-diff-window]")).not.toBeNull());
    drawWindows();
    await waitFor(() => expect(lines("src/f3.ts").length).toBeGreaterThan(0));
    expect(fake.patchPaths()).toEqual(["src/f3.ts"]);
  });

  it("says why when there is nothing to show", async () => {
    fake.files = [];
    await mount();
    expect(screen.getByText("Working tree clean.")).toBeInTheDocument();
  });

  it("says when the folder is not a git repository", async () => {
    fake.listUnavailable = "not-a-repo";
    await mount();
    expect(await screen.findByText("This folder is not a git repository.")).toBeInTheDocument();
  });

  it("a busy first load does not settle the folds: when Refresh then succeeds, the 2 files are open", async () => {
    fake.listUnavailable = "busy";
    await mount();
    expect(await screen.findByText(/The host is busy/)).toBeInTheDocument();
    expect(JSON.stringify(readDiffMemory(diffMemoryKey("t1", WORKING_TREE)).unfolded)).toBe("null"); // nothing saved in its place
    fake.listUnavailable = null;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(sections()).toHaveLength(2));
    await waitFor(() => expect(toggle("src/a.ts")).toHaveAttribute("aria-expanded", "true"));
    expect(toggle("src/b.ts")).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(fake.patchPaths().sort()).toEqual(["src/a.ts", "src/b.ts"]));
  });

  it("a failed first load (the request itself failing) does not settle the folds either", async () => {
    server.use(http.get("/api/files/git/review", () => new HttpResponse("boom", { status: 500 }), { once: true }));
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sections()).toHaveLength(2));
    await waitFor(() => expect(toggle("src/a.ts")).toHaveAttribute("aria-expanded", "true"));
    expect(toggle("src/b.ts")).toHaveAttribute("aria-expanded", "true");
  });

  it("says when Files is off or the folder is outside its root, without asking the review API", async () => {
    server.use(http.get("/api/files/pane-folder", () => new HttpResponse(null, { status: 404 })));
    render(<DiffPanel threadId="t1" />);
    expect(await screen.findByText(/Files isn't turned on/)).toBeInTheDocument();
    expect(fake.listCalls).toHaveLength(0);
  });

  it("says Loading while the list loads", async () => {
    server.use(http.get("/api/files/git/review", async () => { await new Promise((r) => setTimeout(r, 80)); return HttpResponse.json({ available: true, scope: "working-tree", files: [], hidden: 0, truncated: false, diffHash: "x" }); }));
    render(<DiffPanel threadId="t1" />);
    expect(await screen.findByRole("status", { name: "Loading changes" })).toBeInTheDocument();
    expect(await screen.findByText("Working tree clean.")).toBeInTheDocument();
  });

  it("calls preloadDiffRenderer when it mounts", async () => {
    await mount();
    expect(preloadDiffRenderer).toHaveBeenCalled();
  });

  it("states the windowing caveats: find sees drawn lines only, scroll comes back to a file and a place in it", async () => {
    await mount();
    const note = document.querySelector("[data-diff-caveats]")!;
    expect(note).toHaveTextContent("Ctrl+F finds only the lines already drawn");
    expect(note).toHaveTextContent("not an exact line");
  });
});

describe("DiffPanel: file bodies", () => {
  it("shows loading, then the error with a Retry that fetches again", async () => {
    fake.files = [{ path: "src/a.ts", failTimes: 1 }];
    fake.patchDelayMs = 60;
    await mount();
    expect(within(section("src/a.ts")).getByText("Loading…")).toBeInTheDocument();
    const alert = await within(section("src/a.ts")).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load this diff.");
    fake.patchDelayMs = 0;
    fireEvent.click(within(section("src/a.ts")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(lines("src/a.ts").length).toBeGreaterThan(0));
    expect(fake.patchCalls).toHaveLength(2);
  });

  it("says a cut diff was cut and offers Open in Files", async () => {
    fake.files = [{ path: "src/big.ts", truncated: true, patch: fakePatch("src/big.ts") }];
    await mount();
    await waitFor(() => expect(lines("src/big.ts").length).toBeGreaterThan(0));
    const body = section("src/big.ts").querySelector("[data-diff-truncated]") as HTMLElement;
    expect(body).toHaveTextContent("only the first part is shown");
    expect(within(body).getByRole("button", { name: "Open in Files" })).toBeInTheDocument();
  });

  it("shows a binary file as binary and asks for no patch", async () => {
    fake.files = [{ path: "logo.png", binary: true }];
    await mount();
    expect(await within(section("logo.png")).findByText("Binary file: there is no patch to show.")).toBeInTheDocument();
    expect(within(section("logo.png")).getByText("binary")).toBeInTheDocument();
    expect(fake.patchCalls).toHaveLength(0);
  });

  it("says a file the host will not read is too large, without asking for it", async () => {
    fake.files = [{ path: "huge.log", tooLarge: true, kind: "untracked" }];
    await mount();
    expect(await within(section("huge.log")).findByText("This file is too large to show here.")).toBeInTheDocument();
    expect(fake.patchCalls).toHaveLength(0);
  });

  it("marks a deleted file and gives it no Open in Files; a renamed one shows both paths", async () => {
    fake.files = [{ path: "gone.ts", kind: "deleted" }, { path: "new.ts", oldPath: "old.ts", kind: "renamed" }];
    await mount();
    expect(within(section("gone.ts")).getByText("deleted")).toBeInTheDocument();
    expect(within(section("gone.ts")).queryByRole("button", { name: "Open gone.ts in Files" })).toBeNull();
    expect(within(section("new.ts")).getByRole("button", { name: "Open new.ts in Files" })).toBeInTheDocument();
    expect(section("new.ts").querySelector("[data-diff-file-label]")).toHaveTextContent("old.ts → new.ts");
  });

  it("wraps long paths rather than truncating them, clamped to three lines, with the whole path on hover", async () => {
    const long = `${"deep/".repeat(20)}file.ts`;
    fake.files = [{ path: long }];
    await mount();
    const label = section(long).querySelector("[data-diff-file-label]") as HTMLElement;
    expect(label.className).toContain("wrap-anywhere");
    expect(label.className).toContain("line-clamp-3");
    expect(label.className).not.toContain("truncate");
    expect(label).toHaveAttribute("title", long);
    // Sticky, so the path stays in view while its diff scrolls.
    expect(label.closest("h3")!.className).toContain("sticky");
  });

  it("copies a path and opens a file in Files at the repo root's Files path (asked of the bridge once)", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void writes.push(t) } });
    await mount();
    fireEvent.click(within(section("src/a.ts")).getByRole("button", { name: "Copy path src/a.ts" }));
    await waitFor(() => expect(writes).toEqual(["src/a.ts"]));
    fireEvent.click(within(section("src/a.ts")).getByRole("button", { name: "Open src/a.ts in Files" }));
    await waitFor(() => expect(useRightPanelStore.getState().fileRequest).toMatchObject({ threadId: "t1", path: "proj/src/a.ts", kind: "file" }));
    fireEvent.click(within(section("src/b.ts")).getByRole("button", { name: "Open src/b.ts in Files" }));
    await waitFor(() => expect(useRightPanelStore.getState().fileRequest).toMatchObject({ path: "proj/src/b.ts" }));
    expect(rootPathCalls).toBe(1);
    expect(useRightPanelStore.getState().sheet).toBe("files"); // 800 px: a phone, so a sheet
  });
});

describe("DiffPanel: toolbar", () => {
  it("wraps diff lines on a phone by default, scrolls them sideways when Wrap is off, and remembers it per device", async () => {
    await mount();
    await waitFor(() => expect(lines("src/a.ts").length).toBeGreaterThan(0));
    const wrap = screen.getByRole("button", { name: "Wrap" });
    expect(wrap).toHaveAttribute("aria-pressed", "true");
    expect(section("src/a.ts").querySelector("[data-diff-wrap]")).not.toBeNull();
    fireEvent.click(wrap);
    expect(wrap).toHaveAttribute("aria-pressed", "false");
    expect(section("src/a.ts").querySelector("[data-diff-wrap]")).toBeNull();
    expect(useRightPanelStore.getState().diffWrap).toBe(false);
  });

  it("does not wrap by default on a desktop", async () => {
    setViewportWidth(1280);
    await mount();
    expect(screen.getByRole("button", { name: "Wrap" })).toHaveAttribute("aria-pressed", "false");
  });

  it("Collapse all folds the files and keeps their patches", async () => {
    await mount();
    await waitFor(() => expect(section("src/b.ts").querySelector("[data-diff-window]")).not.toBeNull());
    drawWindows();
    await waitFor(() => expect(lines("src/b.ts").length).toBeGreaterThan(0));
    const collapse = screen.getByRole("button", { name: "Collapse all" });
    fireEvent.click(collapse);
    expect(lines("src/a.ts")).toHaveLength(0);
    expect(collapse).toBeDisabled();
    const calls = fake.patchCalls.length;
    fireEvent.click(toggle("src/a.ts"));
    await waitFor(() => expect(lines("src/a.ts").length).toBeGreaterThan(0));
    expect(fake.patchCalls).toHaveLength(calls); // kept, not fetched again
  });
});

describe("DiffPanel: reveal", () => {
  beforeEach(() => {
    fake.files = Array.from({ length: 6 }, (_, i) => ({ path: `src/f${i}.ts` }));
  });

  it("unfolds the revealed file alone, scrolls to it once, marks it, and consumes the request", async () => {
    act(() => useDiffPanelStore.getState().openDiff("t1", WORKING_TREE, "src/f4.ts"));
    await mount();
    await waitFor(() => expect(scrolled).toEqual(["src/f4.ts"]));
    expect(toggle("src/f4.ts")).toHaveAttribute("aria-expanded", "true");
    expect(toggle("src/f0.ts")).toHaveAttribute("aria-expanded", "false"); // not all of them: just the asked-for one
    expect(useDiffPanelStore.getState().reveal).toBeNull();
    // On a phone the tree folds out of the way, as when a file is picked in it.
    expect(document.querySelector("[data-diff-tree-toggle]")).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(lines("src/f4.ts").length).toBeGreaterThan(0));
    expect(fake.patchPaths()).toEqual(["src/f4.ts"]);
    expect(section("src/f4.ts").className).toContain("bg-accent");
    await settle(100);
    expect(scrolled).toEqual(["src/f4.ts"]); // once
  });

  it("scrolls again when the same file is asked for a second time", async () => {
    act(() => useDiffPanelStore.getState().openDiff("t1", WORKING_TREE, "src/f4.ts"));
    await mount();
    await waitFor(() => expect(scrolled).toHaveLength(1));
    act(() => useDiffPanelStore.getState().openDiff("t1", WORKING_TREE, "src/f4.ts"));
    await waitFor(() => expect(scrolled).toHaveLength(2));
  });

  it("scrolls to a file picked in the tree, unfolds it, and folds the tree on a phone", async () => {
    await mount();
    expect(screen.getByRole("tree")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("treeitem", { name: /f3\.ts/ }));
    await waitFor(() => expect(scrolled).toEqual(["src/f3.ts"]));
    expect(toggle("src/f3.ts")).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("tree")).toBeNull();
    expect(document.querySelector("[data-diff-tree-toggle]")).toHaveAttribute("aria-expanded", "false");
  });

  it("ignores a file that is not in the list, and drops the request", async () => {
    act(() => useDiffPanelStore.getState().openDiff("t1", WORKING_TREE, "nope.ts"));
    await mount();
    await waitFor(() => expect(useDiffPanelStore.getState().reveal).toBeNull());
    expect(scrolled).toEqual([]);
  });
});

describe("DiffPanel: branch scope", () => {
  it("compares the branch with its default base, names it, and sends the range to each patch request", async () => {
    act(() => useDiffPanelStore.getState().setScope("t1", { kind: "branch" }));
    await mount();
    expect(screen.getByRole("button", { name: "Compare: Branch vs origin/main" })).toBeInTheDocument();
    await waitFor(() => expect(fake.patchCalls.length).toBeGreaterThan(0));
    expect(fake.listCalls[0]?.searchParams.get("scope")).toBe("branch");
    expect(fake.listCalls[0]?.searchParams.get("base")).toBeNull();
    expect(fake.patchCalls[0]?.searchParams.get("from")).toHaveLength(40);
  });

  it("falls back to the default base, with a note, when the stored base is not a branch any more", async () => {
    act(() => useDiffPanelStore.getState().setScope("t1", { kind: "branch", baseRef: "feature/gone" }));
    await mount();
    expect(await screen.findByText(/feature\/gone isn't a branch here any more/)).toBeInTheDocument();
    // The list was never asked for under the missing base once the branch list had said so.
    await waitFor(() => expect(fake.listCalls.some((u) => u.searchParams.get("scope") === "branch" && u.searchParams.get("base") === null)).toBe(true));
    expect(fake.branchCalls.length).toBeGreaterThan(0);
    // The stored choice is left alone.
    expect(useDiffPanelStore.getState().scopes["t1"]).toEqual({ kind: "branch", baseRef: "feature/gone" });
  });

  it("keeps a stored base the repo still has", async () => {
    act(() => useDiffPanelStore.getState().setScope("t1", { kind: "branch", baseRef: "develop" }));
    await mount();
    expect(screen.queryByText(/isn't a branch here any more/)).toBeNull();
    expect(fake.listCalls.every((u) => u.searchParams.get("base") === "develop")).toBe(true);
    expect(screen.getByRole("button", { name: "Compare: Branch vs develop" })).toBeInTheDocument();
  });

  it("keeps a stored base older than the newest refs the host lists: a cut list does not say it is gone", async () => {
    fake.branchesTruncated = true;
    fake.knownBases.add("release/2019");
    act(() => useDiffPanelStore.getState().setScope("t1", { kind: "branch", baseRef: "release/2019" }));
    await mount();
    await waitFor(() => expect(fake.branchCalls.length).toBeGreaterThan(0));
    await settle(60);
    expect(screen.queryByText(/isn't a branch here any more/)).toBeNull();
    expect(fake.listCalls.every((u) => u.searchParams.get("base") === "release/2019")).toBe(true);
    expect(screen.getByRole("button", { name: "Compare: Branch vs release/2019" })).toBeInTheDocument();
  });

  it("still falls back when the host itself says a base the cut list does not show is bad", async () => {
    fake.branchesTruncated = true; // "ghost" is not in the list, which proves nothing; the host's bad-base does
    act(() => useDiffPanelStore.getState().setScope("t1", { kind: "branch", baseRef: "ghost" }));
    await mount();
    expect(await screen.findByText(/ghost isn't a branch here any more/)).toBeInTheDocument();
    expect(fake.listCalls.some((u) => u.searchParams.get("base") === "ghost")).toBe(true); // asked, and refused
    await waitFor(() => expect(fake.listCalls.some((u) => u.searchParams.get("base") === null)).toBe(true));
  });

  it("picks the scope and the base from a bottom sheet on a phone, with a filter for the branches", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Compare: Working tree" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("option", { name: /Working tree/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(sheet).getByRole("button", { name: /Base:/ }));
    expect(await within(sheet).findByRole("option", { name: /develop/ })).toBeInTheDocument();
    fireEvent.change(within(sheet).getByRole("searchbox", { name: "Filter branches" }), { target: { value: "dev" } });
    expect(within(sheet).queryByRole("option", { name: /^main/ })).toBeNull();
    fireEvent.click(within(sheet).getByRole("option", { name: /develop/ }));
    await waitFor(() => expect(useDiffPanelStore.getState().scopes["t1"]).toEqual({ kind: "branch", baseRef: "develop" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(fake.listCalls.some((u) => u.searchParams.get("base") === "develop")).toBe(true));
  });

  it("picks the scope from a dropdown on a desktop", async () => {
    setViewportWidth(1280);
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Compare: Working tree" }));
    const item = await screen.findByRole("menuitemradio", { name: /Branch vs/ });
    fireEvent.click(item);
    await waitFor(() => expect(useDiffPanelStore.getState().scopes["t1"]).toEqual({ kind: "branch" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("DiffPanel: run scope", () => {
  const inRun = { runId: "r1" };
  const journal = (file: string, before: string, after: string) => `--- a/${file}\n+++ b/${file}\n@@ @@\n ctx\n-${before}\n+${after}\n ctx2`;
  const runItems = (): TurnItem[] => [
    user("u:0", "go", inRun),
    edit("e:0", "src/a.ts", { ...inRun, additions: 1, deletions: 1, diffStr: journal("src/a.ts", "x1", "y1") }),
    edit("e:1", "src/a.ts", { ...inRun, additions: 1, deletions: 1, diffStr: journal("src/a.ts", "x2", "y2") }),
    edit("e:2", "src/a.ts", { ...inRun, additions: 1, deletions: 1, diffStr: journal("src/a.ts", "x3", "y3") }),
    edit("e:3", "docs/n.md", { ...inRun, additions: 2, deletions: 0, diffStr: "--- /dev/null\n+++ b/docs/n.md\n@@ -0,0 +1,2 @@\n+a\n+b" }),
    assistant("m:0", "done", inRun),
  ];

  it("shows a run's files from the journal with no request, several edits to one file as consecutive hunks, and says it is not exact", async () => {
    openThread(runItems(), [runItem("r1", { ordinal: 7 })]);
    act(() => useDiffPanelStore.getState().openDiffForRun("t1", "r1"));
    await mount();
    expect(sections().map((s) => s.dataset.diffFile)).toEqual(["docs/n.md", "src/a.ts"]);
    expect(within(section("src/a.ts")).getByText("3 edits")).toBeInTheDocument();
    await waitFor(() => expect(section("src/a.ts").querySelector("[data-diff-window]")).not.toBeNull());
    drawWindows();
    await waitFor(() => expect(section("src/a.ts").querySelectorAll("[data-diff-line=add]")).toHaveLength(3));
    const hunks = [...section("src/a.ts").querySelectorAll("div")].filter((d) => /^@@ -1,3 \+1,3 @@ edit \d of 3$/.test(d.textContent ?? "") && d.children.length === 0);
    expect(hunks.map((h) => h.textContent)).toEqual(["@@ -1,3 +1,3 @@ edit 1 of 3", "@@ -1,3 +1,3 @@ edit 2 of 3", "@@ -1,3 +1,3 @@ edit 3 of 3"]);
    expect(within(section("docs/n.md")).getByText("added")).toBeInTheDocument();
    const note = document.querySelector("[data-diff-note=run]")!;
    expect(note).toHaveTextContent("From the agent's edits");
    expect(note).toHaveTextContent("may not match what is on disk");
    // T28: a run's line numbers are its own, so no unchanged lines to open, and no -w to ask the host for.
    expect(note).toHaveTextContent("not available for this run");
    expect(section("src/a.ts").querySelector("[data-diff-expand]")).toBeNull();
    expect(screen.getByRole("button", { name: "Ignore whitespace" })).toBeDisabled();
    expect(fake.listCalls).toHaveLength(0);
    expect(fake.patchCalls).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull(); // it follows the thread stream
    expect(screen.getByRole("button", { name: "Compare: Run 7" })).toBeInTheDocument();
  });

  it("works for a thread whose folder is outside the Files root, since it reads the journal", async () => {
    server.use(http.get("/api/files/pane-folder", () => HttpResponse.json({ path: null })));
    openThread(runItems(), [runItem("r1")]);
    act(() => useDiffPanelStore.getState().setScope("t1", { kind: "run", runId: "r1" }));
    await mount();
    expect(sections()).toHaveLength(2);
  });

  it("opens the card's file: the file is unfolded and scrolled to", async () => {
    openThread(runItems(), [runItem("r1")]);
    act(() => useDiffPanelStore.getState().openDiffForRun("t1", "r1", "src/a.ts"));
    await mount();
    await waitFor(() => expect(scrolled).toEqual(["src/a.ts"]));
    expect(toggle("src/a.ts")).toHaveAttribute("aria-expanded", "true");
  });

  it("says a failed edit failed, and a cut diff is cut; never exact", async () => {
    openThread(
      [
        user("u:0", "go", inRun),
        edit("e:0", "bad.ts", { ...inRun, status: "failed", errorText: "String to replace not found" }),
        edit("e:1", "cut.ts", { ...inRun, additions: 1, deletions: 1, diffStr: journal("cut.ts", "a", "b"), truncated: true } as never),
      ],
      [runItem("r1")],
    );
    act(() => useDiffPanelStore.getState().setScope("t1", { kind: "run", runId: "r1" }));
    await mount();
    expect(await within(section("bad.ts")).findByText(/The edit failed: String to replace not found/)).toBeInTheDocument();
    expect(within(section("bad.ts")).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(await within(section("cut.ts")).findByText(/journal cut a long diff/)).toBeInTheDocument();
  });

  it("offers the thread's runs that changed files in the picker, newest first", async () => {
    openThread(
      [
        edit("e:0", "a.ts", { runId: "r1", additions: 1, deletions: 0, diffStr: journal("a.ts", "1", "2") }),
        edit("e:1", "b.ts", { runId: "r2", additions: 1, deletions: 0, diffStr: journal("b.ts", "1", "2") }),
        edit("e:2", "c.ts", { runId: "r2", additions: 1, deletions: 0, diffStr: journal("c.ts", "1", "2") }),
      ],
      [runItem("r1", { ordinal: 1 }), runItem("r2", { ordinal: 2 })],
    );
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Compare: Working tree" }));
    const sheet = await screen.findByRole("dialog");
    const options = within(sheet).getAllByRole("option").map((o) => o.textContent);
    const runs = options.filter((t) => /^Run /.test(t ?? ""));
    expect(runs[0]).toMatch(/^Run 2 · 2 files · /);
    expect(runs[1]).toMatch(/^Run 1 · 1 file · /);
    fireEvent.click(within(sheet).getByRole("option", { name: /^Run 2/ }));
    await waitFor(() => expect(useDiffPanelStore.getState().scopes["t1"]).toEqual({ kind: "run", runId: "r2" }));
    await waitFor(() => expect(sections().map((s) => s.dataset.diffFile)).toEqual(["b.ts", "c.ts"]));
  });

  it("says when the run's edits are not loaded", async () => {
    act(() => useDiffPanelStore.getState().setScope("t1", { kind: "run", runId: "gone" }));
    render(<DiffPanel threadId="t1" />);
    expect(await screen.findByText(/This run's edits aren't loaded/)).toBeInTheDocument();
  });
});

describe("DiffPanel: refresh", () => {
  it("re-reads on the button, sending the last hash, and a 304 leaves the page as it was", async () => {
    await mount();
    await waitFor(() => expect(lines("src/a.ts").length).toBeGreaterThan(0));
    const before = fake.patchCalls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fake.listCalls).toHaveLength(2));
    expect(fake.listHeaders[1]?.ifNoneMatch).toBe('"h1"');
    await settle();
    expect(fake.patchCalls).toHaveLength(before);
    expect(lines("src/a.ts").length).toBeGreaterThan(0);
  });

  it("shows a changed file's new patch after a refresh without a flash of loading", async () => {
    await mount();
    await waitFor(() => expect(section("src/a.ts").textContent).toContain("old 0"));
    fake.setFiles([{ path: "src/a.ts", version: 1 }, { path: "src/b.ts" }]);
    fake.hold = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(section("src/a.ts").querySelector("[data-diff-revalidating]")).not.toBeNull());
    expect(section("src/a.ts").textContent).toContain("old 0"); // the old diff stays while the new one loads
    expect(within(section("src/a.ts")).queryByText("Loading…")).toBeNull();
    act(() => fake.release());
    await waitFor(() => expect(section("src/a.ts").textContent).toContain("old 1"));
  });

  it("re-reads when the thread's run ends, and when the page returns or the network is back", async () => {
    openThread([], [runItem("r1", { status: "running", completedAt: undefined })]);
    await mount();
    expect(fake.listCalls).toHaveLength(1);
    act(() => useThreadStore.setState((s) => ({ current: { ...s.current!, runs: { r1: runItem("r1", { status: "completed" }) } } })));
    await waitFor(() => expect(fake.listCalls).toHaveLength(2));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(fake.listCalls).toHaveLength(3));
    act(() => void window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(fake.listCalls).toHaveLength(4));
  });

  it("makes no request once unmounted", async () => {
    const view = await mount();
    await waitFor(() => expect(lines("src/a.ts").length).toBeGreaterThan(0));
    view.unmount();
    const calls = fake.listCalls.length + fake.patchCalls.length;
    act(() => void window.dispatchEvent(new Event("online")));
    await settle(60);
    expect(fake.listCalls.length + fake.patchCalls.length).toBe(calls);
  });
});

describe("DiffPanel: layout", () => {
  beforeEach(() => {
    fake.files = Array.from({ length: 4 }, (_, i) => ({ path: `src/f${i}.ts` }));
  });

  it("is a left column on a desktop when the panel itself is 600 px wide or more", async () => {
    setViewportWidth(1280);
    await mount();
    resizePanel(420); // the default panel width
    expect(document.querySelector("[data-diff-tree-column]")).toBeNull();
    expect(document.querySelector("[data-diff-tree-toggle]")).not.toBeNull();
    resizePanel(640);
    await waitFor(() => expect(document.querySelector("[data-diff-tree-column]")).not.toBeNull());
    expect(document.querySelector("[data-diff-tree-toggle]")).toBeNull();
    expect(within(document.querySelector("[data-diff-tree-column]") as HTMLElement).getByRole("tree")).toBeInTheDocument();
    // Selecting a tree row scrolls and unfolds, and the column stays.
    fireEvent.click(screen.getByRole("treeitem", { name: /f2\.ts/ }));
    await waitFor(() => expect(scrolled).toEqual(["src/f2.ts"]));
    expect(toggle("src/f2.ts")).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector("[data-diff-tree-column]")).not.toBeNull();
    resizePanel(500);
    await waitFor(() => expect(document.querySelector("[data-diff-tree-column]")).toBeNull());
  });

  it("is one column on a phone however wide the sheet is", async () => {
    setViewportWidth(800);
    await mount();
    resizePanel(800);
    expect(document.querySelector("[data-diff-tree-column]")).toBeNull();
    expect(document.querySelector("[data-diff-tree-toggle]")).not.toBeNull();
  });

  it("has sticky file headers and a picker that is a sheet at phone width", async () => {
    setViewportWidth(390);
    await mount();
    expect(section("src/f0.ts").querySelector("h3")!.className).toContain("sticky");
    fireEvent.click(screen.getByRole("button", { name: "Compare: Working tree" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("observes against its own scroller, so files nearing the edge are found", async () => {
    await mount();
    const scroller = document.querySelector("[data-diff-scroller]");
    expect(ios.some((io) => io.root === scroller)).toBe(true);
  });
});

describe("DiffPanel: remembered state", () => {
  beforeEach(() => {
    fake.files = Array.from({ length: 5 }, (_, i) => ({ path: `src/f${i}.ts` }));
  });

  it("brings back the unfolded files and the folded tree when the sheet is closed and reopened", async () => {
    const first = await mount();
    fireEvent.click(toggle("src/f1.ts"));
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-diff-tree-toggle]")!);
    first.unmount();
    await mount();
    expect(toggle("src/f1.ts")).toHaveAttribute("aria-expanded", "true");
    expect(toggle("src/f0.ts")).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("[data-diff-tree-toggle]")).toHaveAttribute("aria-expanded", "false");
  });

  // jsdom has no layout, so a restore shows as `scrollTop` moving off 0 by the remembered offset.
  const remembered = () => writeDiffMemory(diffMemoryKey("t1", WORKING_TREE), { anchor: { path: "src/f1.ts", offset: 123 } });
  const scroller = () => document.querySelector<HTMLElement>("[data-diff-scroller]") as HTMLElement;

  it("puts the scroll back to the remembered file and offset when it reopens", async () => {
    remembered();
    await mount();
    await waitFor(() => expect(scroller().scrollTop).toBe(123));
  });

  it("a tap-through to another file wins over the remembered place on that remount", async () => {
    remembered();
    act(() => useDiffPanelStore.getState().openDiff("t1", WORKING_TREE, "src/f4.ts"));
    await mount();
    await waitFor(() => expect(scrolled).toEqual(["src/f4.ts"]));
    await settle(150);
    expect(scroller().scrollTop).toBe(0); // the restore did not run over the reveal
    expect(scrolled).toEqual(["src/f4.ts"]);
  });

  it("a tap-through that arrives while the remembered place is still being waited for ends that wait", async () => {
    writeDiffMemory(diffMemoryKey("t1", WORKING_TREE), { anchor: { path: "src/not-here-yet.ts", offset: 77 } });
    await mount();
    act(() => useDiffPanelStore.getState().openDiff("t1", WORKING_TREE, "src/f2.ts"));
    await waitFor(() => expect(scrolled).toEqual(["src/f2.ts"]));
    // The file the old restore wanted turns up late: it must not pull the page back.
    fake.setFiles([...fake.files, { path: "src/not-here-yet.ts" }]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(section("src/not-here-yet.ts")).toBeDefined());
    await settle(100);
    expect(scroller().scrollTop).toBe(0);
  });

  it("keeps a separate memory for each scope of a thread", async () => {
    const first = await mount();
    fireEvent.click(toggle("src/f1.ts"));
    first.unmount();
    act(() => useDiffPanelStore.getState().setScope("t1", { kind: "branch" }));
    await mount();
    expect(toggle("src/f1.ts")).toHaveAttribute("aria-expanded", "false");
  });
});
