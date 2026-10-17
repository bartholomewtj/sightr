// Timeline polish for Claude Code and Pi sessions on a phone: file-name-first path rows, page-fetch and
// MCP labels, Copy on tool bodies, paths that open the Files tab, a background subagent's prompt line,
// and the thread details sheet.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Run, TurnItem } from "@shared/v2/contracts";

import { useMessageToasts } from "@/components/toast";
import { useRightPanelStore } from "@/rightPanelStore";
import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { thread as threadFixture } from "@/test/fixtures";
import { installListLayout } from "@/test/list-layout";
import { assistant, command, edit, read, resetOrdinals, run, user } from "@/test/turn-items";
import { summarizeToolGroup } from "@t3tools/client-runtime/work-log/presentation";
import { deriveTimelineEntries, dynamicToolDisplayName, mcpToolParts } from "~/session-logic";

import { looksLikeFilePath } from "../right-panel/OpenFileLink";
import { MessagesTimeline, splitFilePath } from "./MessagesTimeline";
import { openThreadDetails } from "./ThreadDetailsPanel";

const resolveMock = vi.fn();
const folderMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  resolveFilePath: (...args: unknown[]) => resolveMock(...args),
  fetchPaneFolder: (...args: unknown[]) => folderMock(...args),
}));

beforeEach(() => {
  resetOrdinals();
  installListLayout();
  resolveMock.mockReset();
  folderMock.mockReset();
  folderMock.mockResolvedValue({ path: "work/demo" });
  useMessageToasts.setState({ toasts: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function settle(ms = 50) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function show(items: TurnItem[], runs: Run[], over: Parameters<typeof threadFixture>[1] = {}) {
  useThreadStore.setState({
    current: threadFromSnapshot(
      {
        sequence: 1,
        thread: threadFixture("t1", { capabilities: { ...threadFixture("t1").capabilities, hasJournal: true }, ...over }),
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
  render(<MessagesTimeline threadId="t1" />);
  await settle();
}

const inRun = { runId: "r1" };
const live = run("r1", { status: "running", completedAt: undefined, startedAt: Date.now() - 30_000 });

function item(id: string, fields: Record<string, unknown>): TurnItem {
  return { ...user(id, "", inRun), ...fields } as unknown as TurnItem;
}

const fetchItem = (id: string, url: string) =>
  item(id, { type: "web_search", title: "WebFetch", patterns: [url], results: [{ url, snippet: "A page." }] });

describe("labels", () => {
  it("names an MCP tool '<tool> · <server>'", () => {
    expect(mcpToolParts("mcp__claude-in-chrome__tabs_context_mcp")).toEqual({ server: "claude-in-chrome", tool: "tabs_context_mcp" });
    expect(dynamicToolDisplayName("mcp__whistlr__send")).toBe("send · whistlr");
    expect(dynamicToolDisplayName("Skill")).toBe("Skill");
    expect(mcpToolParts("Read")).toBeNull();
  });

  it("summarises page fetches as fetches, not web searches", () => {
    const entries = (items: TurnItem[]) =>
      deriveTimelineEntries({ items, runs: [] }).flatMap((e) => (e.kind === "work" ? [e.entry] : []));
    expect(summarizeToolGroup(entries([fetchItem("a:0", "https://example.com/a")])).summary).toBe("Fetched example.com");
    expect(summarizeToolGroup(entries([fetchItem("a:0", "https://example.com/a"), fetchItem("b:0", "https://example.com/b")])).summary).toBe(
      "Fetched 2 pages from example.com",
    );
    const search = item("s:0", { type: "web_search", title: "WebSearch", patterns: ["bun test flags"] });
    expect(summarizeToolGroup(entries([fetchItem("a:0", "https://a.dev/x"), fetchItem("b:0", "https://b.dev/y"), search])).summary).toBe(
      "Fetched 2 pages and searched the web 1 time",
    );
  });

  it("splits a path into its file name and folder", () => {
    expect(splitFilePath("docs/sub/notes.md")).toEqual({ name: "notes.md", dir: "docs/sub" });
    expect(splitFilePath("C:\\a\\b.ts")).toEqual({ name: "b.ts", dir: "C:\\a" });
    expect(splitFilePath("notes.md")).toEqual({ name: "notes.md", dir: "" });
  });

  it("knows a printed file path from other inline code", () => {
    for (const yes of ["notes.md", "web2/src/x.ts:12", "src/a.ts:12:3", "C:\\work\\demo\\a.ts", "./bridge/journal", "package.json"]) {
      expect(looksLikeFilePath(yes), yes).toBe(true);
    }
    for (const no of ["foo()", "e.g.", "bun test", "https://example.com/a.ts", "a = b", "v1.2.3", "--flag", "user.name", "@shared/v2/contracts", "x"]) {
      expect(looksLikeFilePath(no), no).toBe(false);
    }
  });
});

describe("timeline rows on a phone", () => {
  it("leads a changed file's row with its name; the folder follows, dim", async () => {
    const one = { ...edit("f:0", "docs/sub/notes.md", inRun), additions: 1, deletions: 1 } as TurnItem;
    const two = edit("g:0", "src/app.ts", inRun);
    await show([user("u:0", "go", inRun), one, two, assistant("b:0", "ok", inRun)], [live]);
    fireEvent.click(screen.getByRole("button", { name: "Changed 2 files" }));
    await settle();
    const labels = [...document.querySelectorAll("[data-file-path-label]")];
    const notes = labels.find((l) => l.getAttribute("title") === "docs/sub/notes.md") as HTMLElement;
    expect(notes).toBeTruthy();
    expect(notes.children[0]).toHaveTextContent("notes.md");
    expect(notes.children[1]).toHaveTextContent("docs/sub");
    expect(notes.children[1]!.getAttribute("dir")).toBe("rtl");
    expect(notes.children[1]!.className).toContain("text-muted-foreground");
  });

  it("leads a read row with 'Read' and the file name", async () => {
    await show([user("u:0", "go", inRun), read("r:0", "bridge/journal/claude.ts", { ...inRun, output: "x" }), assistant("b:0", "ok", inRun)], [live]);
    const label = document.querySelector("[data-file-path-label]") as HTMLElement;
    expect(label.textContent).toBe("Readclaude.tsbridge/journal");
  });

  it("labels an MCP call by tool and server", async () => {
    const tool = item("m:0", { type: "dynamic_tool", title: "mcp__claude-in-chrome__navigate", toolName: "mcp__claude-in-chrome__navigate", input: "https://example.com/", output: "ok" });
    await show([user("u:0", "go", inRun), tool, assistant("b:0", "ok", inRun)], [live]);
    expect(screen.getByText("navigate · claude-in-chrome https://example.com/")).toBeInTheDocument();
    expect(screen.queryByText(/mcp__/)).toBeNull();
  });

  it("puts Copy on a command and on its output", async () => {
    const cmd = command("c:0", "bun test", { ...inRun, output: "3 pass\n1 fail", exitCode: 1, status: "failed" });
    await show([user("u:0", "go", inRun), cmd, assistant("b:0", "ok", inRun)], [run("r1", { status: "failed" })]);
    expect(await screen.findByRole("button", { name: "Copy command" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy output" })).toBeInTheDocument();
  });

  it("opens a changed file's path in Files, and says why when the bridge refuses", async () => {
    resolveMock.mockResolvedValueOnce({ path: "demo/docs/notes.md", kind: "file" });
    const change = { ...edit("f:0", "docs/notes.md", { ...inRun, status: "failed" }), errorText: "nope" } as TurnItem;
    await show([user("u:0", "go", inRun), change, assistant("b:0", "ok", inRun)], [run("r1", { status: "failed" })]);
    const link = (await screen.findByLabelText("Error")).closest("[data-tool-detail]")!.querySelector("[data-open-file]") as HTMLElement;
    fireEvent.click(link);
    await settle();
    expect(resolveMock).toHaveBeenCalledWith("p-t1", "docs/notes.md");
    expect(useRightPanelStore.getState().fileRequest).toMatchObject({ threadId: "t1", path: "demo/docs/notes.md", kind: "file" });

    resolveMock.mockResolvedValueOnce({ path: null, reason: "outside-root" });
    fireEvent.click(link);
    await settle();
    expect(useMessageToasts.getState().toasts.at(-1)?.text).toMatch(/outside the Files root/);
  });

  it("links a path an agent wrote as inline code, and nothing else", async () => {
    await show([user("u:0", "go", inRun), assistant("b:0", "Edited `docs/notes.md:2` with `sed -i`.", inRun)], [run("r1")]);
    const links = [...document.querySelectorAll("[data-open-file]")];
    expect(links.map((l) => l.getAttribute("data-open-file"))).toEqual(["docs/notes.md:2"]);
    expect(links[0]!.closest("code")).toBeTruthy();
  });

  it("shows a background subagent's prompt until its result lands", async () => {
    const sub = item("s:0", {
      type: "subagent",
      title: "Survey the docs",
      subagentId: "a1",
      origin: "provider_native",
      driver: "claude",
      providerInstanceId: "claude",
      childThreadId: null,
      prompt: "List the docs and say which are stale.",
      result: "",
      agentStatus: "async_launched",
    });
    await show([user("u:0", "go", inRun), sub, assistant("b:0", "ok", inRun)], [run("r1")]);
    const row = screen.getByRole("button", { name: "Survey the docs, Running in the background" });
    expect(row).toHaveTextContent("List the docs and say which are stale.");
    expect(row).not.toHaveTextContent(/Async agent launched/);
  });
});

describe("thread details", () => {
  it("opens a sheet with the harness, model, mode, folder, session id, runs and created time", async () => {
    await show([user("u:0", "go", inRun), assistant("b:0", "ok", inRun)], [run("r1")], {
      model: "claude-haiku-5-5",
      permissionMode: "acceptEdits",
      sessionRef: { kind: "id", value: "290a2b12-973b-47d1-ae45-3c629c92b769" },
    });
    act(() => openThreadDetails("t1"));
    await settle();
    const sheet = document.querySelector("[data-thread-details]") as HTMLElement;
    expect(sheet).toBeTruthy();
    const value = (label: string) => sheet.querySelector(`[data-thread-detail="${label}"] dd`)?.textContent;
    expect(value("Harness")).toBe("Claude Code");
    expect(value("Model")).toBe("claude-haiku-5-5");
    expect(value("Permission mode")).toBe("acceptEdits");
    expect(value("Folder")).toBe("work/demo");
    expect(value("Session id")).toBe("290a2b12-973b-47d1-ae45-3c629c92b769");
    expect(value("Runs")).toBe("1");
    expect(value("Created")).not.toBe("—");
    expect(within(sheet).getByRole("button", { name: "Copy session id" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close thread details" }));
    await settle(300);
    expect(document.querySelector("[data-thread-details]")).toBeNull();
  });
});
