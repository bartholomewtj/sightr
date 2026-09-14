import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { FilesGit } from "./files-git";
import type { AgentView, FolderGitResponse } from "@/lib/types";

const pane: AgentView = { paneId: "p1", workspaceId: "w", workspaceLabel: "Work", workspaceNumber: 1, tabId: "t", agent: "claude", status: "working", cwd: "/work/repo", focused: true };
const available = (extra: Partial<Extract<FolderGitResponse, { available: true }>> = {}): Extract<FolderGitResponse, { available: true }> => ({ available: true, repo: "repo", rel: "src", clean: false, entries: [{ path: "src/a.ts", x: ".", y: "M" }], hidden: 0, statusTruncated: false, diff: "@@ -1 +1 @@\n-old\n+new\n", diffTruncated: false, panes: [], ...extra });
const Location = () => <span data-testid="location">{useLocation().pathname}</span>;
const view = (ui: React.ReactElement, withLocation = false) => render(<MemoryRouter>{ui}{withLocation && <Location />}</MemoryRouter>);
describe("FilesGit", () => {
  beforeEach(() => server.resetHandlers()); afterEach(() => server.resetHandlers());
  function stub(body: FolderGitResponse) { server.use(http.get("/api/files/git", () => HttpResponse.json(body))); }
  it("is collapsed, then fetches and renders status and diff", async () => { stub(available({ branch: "main" })); view(<FilesGit path="Projects/tools/sightr" panes={[pane]} />); fireEvent.click(screen.getByRole("button", { name: /Git/ })); expect(await screen.findByText("main · repo/src")).toBeInTheDocument(); expect(screen.getByText("src/a.ts")).toBeInTheDocument(); });
  it("counts hidden paths without naming them", async () => { stub(available({ entries: [], hidden: 2, clean: false })); view(<FilesGit path="" panes={[]} />); fireEvent.click(screen.getByRole("button", { name: /Git/ })); expect(await screen.findByText("2 hidden files not shown")).toBeInTheDocument(); expect(document.body.textContent).not.toContain(".env"); });
  it("renders clean and unavailable states", async () => { stub(available({ clean: true, diff: "" })); view(<FilesGit path="" panes={[]} />); fireEvent.click(screen.getByRole("button", { name: /Git/ })); expect(await screen.findByText("Working tree clean")).toBeInTheDocument(); });
  it("names the selected folder and explains not-a-repo", async () => { stub({ available: false, reason: "not-a-repo" }); view(<FilesGit path="Projects/tools/sightr" panes={[]} />); expect(screen.getByText("Projects/tools/sightr")).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: /Git/ })); expect(await screen.findByText(/isn't inside a checkout/)).toBeInTheDocument(); expect(document.body.textContent).not.toContain("focused pane"); });
  it("shows panes parked in the repo", async () => { stub(available({ panes: ["p1"] })); view(<FilesGit path="repo" panes={[pane]} />); fireEvent.click(screen.getByRole("button", { name: /Git/ })); expect(await screen.findByRole("button", { name: /claude/ })).toBeInTheDocument(); });
  it("has no panes empty state", async () => { stub(available()); view(<FilesGit path="" panes={[]} />); fireEvent.click(screen.getByRole("button", { name: /Git/ })); expect(await screen.findByText("No panes in this repo")).toBeInTheDocument(); });
  it("requests the selected folder and every known pane", async () => {
    let requested = ""; server.use(http.get("/api/files/git", ({ request }) => { requested = request.url; return HttpResponse.json(available()); }));
    const second = { ...pane, paneId: "shell:2", agent: "bash" } as AgentView;
    view(<FilesGit path="Projects/tools/sightr" panes={[pane, second]} />); fireEvent.click(screen.getByRole("button", { name: /Git/ }));
    await screen.findByText("No panes in this repo"); const query = new URL(requested).searchParams;
    expect(query.get("path")).toBe("Projects/tools/sightr"); expect(query.getAll("pane")).toEqual(["p1", "shell:2"]);
  });
  it("navigates to a pane chip", async () => {
    stub(available({ panes: ["p1"] })); view(<FilesGit path="repo" panes={[pane]} />, true); fireEvent.click(screen.getByRole("button", { name: /Git/ }));
    fireEvent.click(await screen.findByRole("button", { name: /claude/ })); expect(await screen.findByTestId("location")).toHaveTextContent("/pane/p1");
  });
  it("does not refetch when the pane array identity changes", async () => {
    let requests = 0; server.use(http.get("/api/files/git", () => { requests++; return HttpResponse.json(available()); }));
    const first = view(<FilesGit path="repo" panes={[pane]} />); fireEvent.click(screen.getByRole("button", { name: /Git/ })); await screen.findByText("No panes in this repo");
    first.rerender(<MemoryRouter><FilesGit path="repo" panes={[{ ...pane }]} /></MemoryRouter>); await new Promise((resolve) => setTimeout(resolve, 20)); expect(requests).toBe(1);
  });
  it("renders truncation and no-commits indicators", async () => {
    stub(available({ statusTruncated: true, diffTruncated: true, noCommits: true })); view(<FilesGit path="repo" panes={[]} />); fireEvent.click(screen.getByRole("button", { name: /Git/ }));
    expect(await screen.findByText("first 500 changes shown")).toBeInTheDocument(); expect(screen.getByText("diff truncated")).toBeInTheDocument(); expect(screen.getByText("no commits yet — nothing to diff against")).toBeInTheDocument();
  });
  it("renders every unavailable reason", async () => {
    for (const reason of ["outside-root", "not-a-repo", "git-unavailable", "timeout"] as const) {
      stub({ available: false, reason }); const { unmount } = view(<FilesGit path="repo" panes={[]} />); fireEvent.click(screen.getByRole("button", { name: /Git/ }));
      await waitFor(() => expect(screen.getByText({ "outside-root": "This folder is outside the Files root", "not-a-repo": "Not a git repo — this folder isn't inside a checkout. Browse into one and open Git there.", "git-unavailable": "git isn't installed on the host", timeout: "git took too long" }[reason])).toBeInTheDocument()); unmount();
    }
  });
  it("has no write controls", async () => { stub(available({ clean: true, diff: "" })); view(<FilesGit path="" panes={[]} />); fireEvent.click(screen.getByRole("button", { name: /Git/ })); await screen.findByText("Working tree clean"); expect(screen.getAllByRole("button").filter((button) => /commit|stage|unstage|push|checkout|discard|stash|revert/i.test(button.textContent ?? ""))).toHaveLength(0); expect(screen.queryAllByRole("link")).toHaveLength(0); });
});
