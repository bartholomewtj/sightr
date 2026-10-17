import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { Run } from "@shared/v2/contracts";
import type { FolderGitDiffResponse, FolderGitResponse } from "@shared/wire";
import { useRightPanelStore } from "@/rightPanelStore";
import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { thread, threadSnapshot } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

import { __resetGitNav, GitPanel } from "./GitPanel";
import { relativeTime, syncLabel } from "./GitPanel.logic";

const DIFF = ["diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
const NOW = Math.floor(Date.now() / 1000);
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

const dirty: FolderGitResponse = {
  available: true,
  repo: "proj",
  rel: "",
  branch: "main",
  clean: false,
  entries: [
    { path: "src/a.ts", x: ".", y: "M" },
    { path: "notes.md", x: "?", y: "?" },
    { path: "gone.ts", x: ".", y: "D" },
  ],
  hidden: 0,
  statusTruncated: false,
  diff: DIFF,
  diffTruncated: false,
  panes: ["p-t1"],
  rootPath: "proj",
  upstream: "origin/main",
  base: "origin/main",
  ahead: 2,
  behind: 0,
  commits: [
    { sha: SHA1, short: "1111111", subject: "Add the parser", author: "Claude", time: NOW - 3 * 3600, parents: 1, files: 2, added: 10, removed: 3, ahead: true },
    { sha: SHA2, short: "2222222", subject: "Initial commit", author: "Bart", time: NOW - 3 * 86_400, parents: 0, files: 1, added: 1, removed: 0 },
  ],
};

const COMMIT_DIFF = ["diff --git a/src/parse.ts b/src/parse.ts", "--- a/src/parse.ts", "+++ b/src/parse.ts", "@@ -0,0 +1 @@", "+export const parse = 1;", ""].join("\n");
const commitAnswer: FolderGitDiffResponse = {
  available: true,
  scope: "commit",
  commit: dirty.available ? dirty.commits![0]! : (undefined as never),
  files: [
    { path: "src/parse.ts", added: 1, removed: 0 },
    { path: "logo.png", added: 0, removed: 0, binary: true },
  ],
  hidden: 1,
  filesTruncated: false,
  diff: COMMIT_DIFF,
  diffTruncated: false,
};

let gitCalls: URL[] = [];
let diffCalls: URL[] = [];
let answer: FolderGitResponse = dirty;

function run(id: string, status: Run["status"]): Run {
  return { id, threadId: "t1", ordinal: 1, status, startedAt: 1 };
}

function openThread(runs: Run[] = []) {
  const state = threadFromSnapshot(threadSnapshot(3, thread("t1")), false);
  act(() => useThreadStore.setState({ current: { ...state, runs: Object.fromEntries(runs.map((r) => [r.id, r])) }, missing: null }));
}

/** The expand button of a file row. */
async function fileButton(path: string): Promise<HTMLButtonElement> {
  const li = await waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-git-file="${path}"]`);
    if (!el) throw new Error(`no row ${path}`);
    return el;
  });
  return within(li).getAllByRole("button")[0] as HTMLButtonElement;
}

beforeEach(() => {
  __resetGitNav();
  gitCalls = [];
  diffCalls = [];
  answer = dirty;
  server.use(
    http.get("/api/files/pane-folder", () => HttpResponse.json({ path: "proj" })),
    http.get("/api/files/git", ({ request }) => {
      gitCalls.push(new URL(request.url));
      return HttpResponse.json(answer);
    }),
    http.get("/api/files/git/diff", ({ request }) => {
      const url = new URL(request.url);
      diffCalls.push(url);
      if (url.searchParams.get("scope") === "branch")
        return HttpResponse.json({ available: true, scope: "branch", base: "origin/main", files: [{ path: "src/parse.ts", added: 1, removed: 0 }], hidden: 0, filesTruncated: false, diff: COMMIT_DIFF, diffTruncated: false } satisfies FolderGitDiffResponse);
      return HttpResponse.json(commitAnswer);
    }),
  );
  openThread();
});

describe("GitPanel", () => {
  it("shows the branch, how far it is ahead of its upstream, and the changed files with their status letters", async () => {
    render(<GitPanel threadId="t1" />);
    expect(await screen.findByText("main · proj")).toBeInTheDocument();
    const sync = document.querySelector("[data-git-sync]")!;
    expect(sync).toHaveTextContent("↑2 ↓0 · origin/main");
    expect(sync).toHaveAttribute("aria-label", "2 commits ahead of origin/main");
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText(".M")).toBeInTheDocument();
    expect(screen.getByText("??")).toBeInTheDocument();
    expect(gitCalls[0]?.searchParams.get("path")).toBe("proj");
    expect(gitCalls[0]?.searchParams.getAll("pane")).toEqual(["p-t1"]);
  });

  it("counts each changed file's added and removed lines", async () => {
    render(<GitPanel threadId="t1" />);
    const li = (await fileButton("src/a.ts")).closest("li")!;
    expect(within(li).getByRole("group", { name: "1 additions, 1 deletions" })).toHaveTextContent("+1-1");
  });

  it("expands a file's diff on tap", async () => {
    render(<GitPanel threadId="t1" />);
    const row = await fileButton("src/a.ts");
    expect(document.querySelector('[data-diff-line="+"]')).toBeNull();
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector('[data-diff-line="+"]')).toHaveTextContent("+new");
    expect(document.querySelector('[data-diff-line="-"]')).toHaveTextContent("-old");
    // An untracked file has no diff to open.
    expect(await fileButton("notes.md")).toBeDisabled();
  });

  it("keeps the expanded file when the sheet is closed and reopened", async () => {
    const first = render(<GitPanel threadId="t1" />);
    fireEvent.click(await fileButton("src/a.ts"));
    first.unmount();
    render(<GitPanel threadId="t1" />);
    expect(await fileButton("src/a.ts")).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector('[data-diff-line="+"]')).toHaveTextContent("+new");
  });

  it("wraps long paths, wraps diff lines on a phone, and scrolls them sideways on their own when Wrap is off", async () => {
    render(<GitPanel threadId="t1" />);
    const row = await fileButton("src/a.ts");
    expect(row.querySelector("span.wrap-anywhere")).toHaveTextContent("src/a.ts");
    expect(row.querySelector("span.truncate")).toBeNull();
    fireEvent.click(row);
    expect(document.querySelector("pre")?.className).toContain("whitespace-pre-wrap");
    const wrap = screen.getByRole("button", { name: "Wrap" });
    expect(wrap).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(wrap);
    const pre = document.querySelector("pre");
    expect(pre?.className).toContain("overflow-x-auto");
    expect(pre?.className).toContain("overscroll-x-contain");
    expect(useRightPanelStore.getState().diffWrap).toBe(false);
  });

  it("does not wrap by default on a desktop", async () => {
    setViewportWidth(1280);
    render(<GitPanel threadId="t1" />);
    fireEvent.click(await fileButton("src/a.ts"));
    expect(screen.getByRole("button", { name: "Wrap" })).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector("pre")?.className).toContain("overflow-x-auto");
  });

  it("collapses every open diff at once", async () => {
    render(<GitPanel threadId="t1" />);
    const collapse = await screen.findByRole("button", { name: "Collapse all" });
    expect(collapse).toBeDisabled();
    fireEvent.click(await fileButton("src/a.ts"));
    fireEvent.click(collapse);
    expect(await fileButton("src/a.ts")).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("pre")).toBeNull();
  });

  it("copies a file's path and opens it in Files, except a deleted file", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void writes.push(t) } });
    render(<GitPanel threadId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy path src/a.ts" }));
    await waitFor(() => expect(writes).toEqual(["src/a.ts"]));
    fireEvent.click(screen.getByRole("button", { name: "Open src/a.ts in Files" }));
    expect(useRightPanelStore.getState().fileRequest).toMatchObject({ threadId: "t1", path: "proj/src/a.ts", kind: "file" });
    // 800 px is the phone layout: the Files sheet opens.
    expect(useRightPanelStore.getState().sheet).toBe("files");
    expect(screen.queryByRole("button", { name: "Open gone.ts in Files" })).toBeNull();
  });

  it("lists recent commits, marks the unpushed ones, and opens a commit's files and diffs", async () => {
    render(<GitPanel threadId="t1" />);
    const list = await screen.findByRole("list", { name: "Recent commits" });
    const rows = within(list).getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Add the parser");
    expect(rows[0]).toHaveTextContent("1111111");
    expect(rows[0]).toHaveTextContent("3h ago");
    expect(rows[0]).toHaveTextContent("not pushed");
    expect(rows[0]).toHaveTextContent("2 files");
    expect(rows[1]).not.toHaveTextContent("not pushed");
    fireEvent.click(rows[0]!);
    expect(await screen.findByText("1 hidden file not shown.")).toBeInTheDocument();
    expect(diffCalls[0]?.searchParams.get("scope")).toBe("commit");
    expect(diffCalls[0]?.searchParams.get("sha")).toBe(SHA1);
    expect(diffCalls[0]?.searchParams.get("path")).toBe("proj");
    expect(screen.getByText("binary")).toBeInTheDocument();
    fireEvent.click(await fileButton("src/parse.ts"));
    expect(document.querySelector('[data-diff-line="+"]')).toHaveTextContent("+export const parse = 1;");
    expect(await fileButton("logo.png")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Open src/parse.ts in Files" }));
    expect(useRightPanelStore.getState().fileRequest).toMatchObject({ path: "proj/src/parse.ts" });
  });

  it("compares the whole branch with its base and goes back to the overview", async () => {
    const first = render(<GitPanel threadId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: /All 2 commits not on origin\/main/ }));
    expect(await screen.findByText(/since it left origin\/main/)).toBeInTheDocument();
    expect(diffCalls[0]?.searchParams.get("scope")).toBe("branch");
    expect(diffCalls[0]?.searchParams.has("sha")).toBe(false);
    // The view survives a closed and reopened sheet.
    first.unmount();
    render(<GitPanel threadId="t1" />);
    expect(await screen.findByText(/since it left origin\/main/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All changes" }));
    expect(await screen.findByRole("list", { name: "Recent commits" })).toBeInTheDocument();
  });

  it("says why a commit can't be shown", async () => {
    server.use(http.get("/api/files/git/diff", () => HttpResponse.json({ available: false, reason: "bad-commit" })));
    render(<GitPanel threadId="t1" />);
    fireEvent.click(within(await screen.findByRole("list", { name: "Recent commits" })).getAllByRole("button")[1]!);
    expect(await screen.findByText("That commit isn't in this repository any more.")).toBeInTheDocument();
  });

  it("says when the branch has no upstream to compare with", async () => {
    answer = { ...dirty, upstream: undefined, base: undefined, ahead: undefined, behind: undefined } as FolderGitResponse;
    render(<GitPanel threadId="t1" />);
    expect(await screen.findByText("No upstream")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /not on/ })).toBeNull();
  });

  it("re-reads when the network comes back or the page returns to the foreground", async () => {
    render(<GitPanel threadId="t1" />);
    await screen.findByText("main · proj");
    expect(gitCalls).toHaveLength(1);
    act(() => void window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(gitCalls).toHaveLength(2));
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(gitCalls).toHaveLength(3));
  });

  it("says when the folder is not a git repository", async () => {
    answer = { available: false, reason: "not-a-repo" };
    render(<GitPanel threadId="t1" />);
    expect(await screen.findByText("This folder is not a git repository.")).toBeInTheDocument();
  });

  it("refreshes on the button and when the thread's run ends", async () => {
    openThread([run("r1", "running")]);
    render(<GitPanel threadId="t1" />);
    await screen.findByText("main · proj");
    expect(gitCalls).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(gitCalls).toHaveLength(2));
    answer = { ...dirty, clean: true, entries: [], diff: "" };
    openThread([run("r1", "completed")]);
    await waitFor(() => expect(gitCalls).toHaveLength(3));
    expect(await screen.findByText("Working tree clean.")).toBeInTheDocument();
  });
});

describe("GitPanel.logic", () => {
  it("says how long ago and how far ahead", () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now / 1000 - 10, now)).toBe("just now");
    expect(relativeTime(now / 1000 - 5 * 60, now)).toBe("5m ago");
    expect(relativeTime(now / 1000 - 2 * 86_400, now)).toBe("2d ago");
    expect(relativeTime(now / 1000 - 15 * 86_400, now)).toBe("2w ago");
    expect(syncLabel(0, 0, "origin/main")).toBe("Up to date with origin/main");
    expect(syncLabel(1, 0, "origin/main")).toBe("1 commit ahead of origin/main");
    expect(syncLabel(0, 3, "main")).toBe("3 commits behind main");
    expect(syncLabel(2, 1, "main")).toBe("2 commits ahead of and 1 behind main");
  });
});
