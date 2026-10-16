import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { Run } from "@shared/v2/contracts";
import type { FolderGitResponse } from "@shared/wire";
import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { thread, threadSnapshot } from "@/test/fixtures";
import { server } from "@/test/setup";

import { GitPanel } from "./GitPanel";

const DIFF = ["diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");

const dirty: FolderGitResponse = {
  available: true,
  repo: "proj",
  rel: "",
  branch: "main",
  clean: false,
  entries: [
    { path: "src/a.ts", x: ".", y: "M" },
    { path: "notes.md", x: "?", y: "?" },
  ],
  hidden: 0,
  statusTruncated: false,
  diff: DIFF,
  diffTruncated: false,
  panes: ["p-t1"],
};

let gitCalls: URL[] = [];
let answer: FolderGitResponse = dirty;

function run(id: string, status: Run["status"]): Run {
  return { id, threadId: "t1", ordinal: 1, status, startedAt: 1 };
}

function openThread(runs: Run[] = []) {
  const state = threadFromSnapshot(threadSnapshot(3, thread("t1")), false);
  act(() => useThreadStore.setState({ current: { ...state, runs: Object.fromEntries(runs.map((r) => [r.id, r])) }, missing: null }));
}

beforeEach(() => {
  gitCalls = [];
  answer = dirty;
  server.use(
    http.get("/api/files/pane-folder", () => HttpResponse.json({ path: "proj" })),
    http.get("/api/files/git", ({ request }) => {
      gitCalls.push(new URL(request.url));
      return HttpResponse.json(answer);
    }),
  );
  openThread();
});

describe("GitPanel", () => {
  it("shows the branch and the changed files with their status letters for the thread's folder", async () => {
    render(<GitPanel threadId="t1" />);
    expect(await screen.findByText("main · proj")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText(".M")).toBeInTheDocument();
    expect(screen.getByText("??")).toBeInTheDocument();
    expect(gitCalls[0]?.searchParams.get("path")).toBe("proj");
    expect(gitCalls[0]?.searchParams.getAll("pane")).toEqual(["p-t1"]);
  });

  it("expands a file's diff on tap", async () => {
    render(<GitPanel threadId="t1" />);
    const row = await screen.findByRole("button", { name: /src\/a\.ts/ });
    expect(document.querySelector('[data-diff-line="+"]')).toBeNull();
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector('[data-diff-line="+"]')).toHaveTextContent("+new");
    expect(document.querySelector('[data-diff-line="-"]')).toHaveTextContent("-old");
    // An untracked file has no diff to open.
    expect(screen.getByRole("button", { name: /notes\.md/ })).toBeDisabled();
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
