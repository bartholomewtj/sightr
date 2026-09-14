import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { __resetFilesTree, open, noteDeletedFile } from "@/lib/files-tree";
import { __resetDesktop, setDesktop } from "@/lib/desktop";
import { FilesTree, FileSearchResults } from "./files-tree";
import type { FileEntry, FilesResponse } from "@/lib/types";

const dir = (path: string, entries: FileEntry[]) => ({ kind: "dir" as const, path, entries, truncated: false });
function renderTree(root?: Extract<FilesResponse, { kind: "dir" }>, selected?: string) {
  const router = createMemoryRouter([{ path: "*", element: <FilesTree root={root} selected={selected} /> }], { initialEntries: ["/files"] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("FilesTree", () => {
  beforeEach(() => { __resetFilesTree(); __resetDesktop(); });
  afterEach(() => { __resetFilesTree(); __resetDesktop(); vi.unstubAllGlobals(); });
  it("opens folder actions on contextmenu without expanding", async () => {
    renderTree(dir("", [{ name: "src", kind: "dir", mtimeMs: 1 }, { name: "README.md", kind: "file", size: 1, mtimeMs: 1 }]));
    fireEvent.contextMenu(screen.getByText("src"));
    const download = await screen.findByRole("link", { name: /Download/ });
    expect(download).toHaveAttribute("href", "/api/files/download?path=src");
    expect(download).not.toHaveAttribute("download");
    expect(screen.getByText("Copy path")).toBeInTheDocument();
    expect(screen.queryByText("nav.ts")).toBeNull();
  });
  it("starts the zip as a navigation so Chrome does not name a 413 download.txt", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign });
    renderTree(dir("", [{ name: "src", kind: "dir", mtimeMs: 1 }]));
    fireEvent.contextMenu(screen.getByText("src"));
    fireEvent.click(await screen.findByRole("link", { name: /Download/ }));
    expect(assign).toHaveBeenCalledWith("/api/files/download?path=src");
    vi.unstubAllGlobals();
  });
  it("keeps folder click as expand", async () => {
    server.use(http.get("/api/files", () => HttpResponse.json(dir("src", [{ name: "nav.ts", kind: "file", size: 1, mtimeMs: 1 }]))));
    renderTree(dir("", [{ name: "src", kind: "dir", mtimeMs: 1 }])); fireEvent.click(screen.getByText("src"));
    expect(await screen.findByText("nav.ts")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Download/ })).toBeNull();
  });
  it("reports the tapped folder, then its parent when the folder closes", async () => {
    const onFolderSelect = vi.fn();
    const router = createMemoryRouter([{ path: "*", element: <FilesTree root={dir("", [{ name: "src", kind: "dir", mtimeMs: 1 }])} onFolderSelect={onFolderSelect} /> }], { initialEntries: ["/files"] });
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByText("src"));
    expect(onFolderSelect).toHaveBeenCalledWith("src");
    expect(router.state.location.pathname).toBe("/files");
    fireEvent.click(screen.getByText("src"));
    expect(onFolderSelect).toHaveBeenLastCalledWith("");
  });
  it("keeps file contextmenus inert", () => {
    renderTree(dir("", [{ name: "README.md", kind: "file", size: 1, mtimeMs: 1 }]));
    fireEvent.contextMenu(screen.getByText("README.md"));
    expect(screen.queryByRole("link", { name: /Download/ })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("swaps the phone sheet for a desktop popover and keeps the chevron inert", () => {
    renderTree(dir("", [{ name: "src", kind: "dir", mtimeMs: 1 }]));
    fireEvent.contextMenu(screen.getByText("src"));
    expect(screen.queryByTestId("action-popover")).toBeNull();
    expect(document.querySelector('button[aria-hidden="true"]')).not.toBeNull();

    cleanup(); __resetFilesTree(); __resetDesktop(); setDesktop(true);
    renderTree(dir("", [{ name: "src", kind: "dir", mtimeMs: 1 }]));
    fireEvent.contextMenu(screen.getByText("src"));
    expect(screen.getByTestId("action-popover")).toHaveTextContent("Download");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("action-popover")).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Expand src" }));
    expect(screen.queryByTestId("action-popover")).toBeNull();
  });
  it("offers download for a directory search hit and leaves file hits inert", async () => {
    const router = createMemoryRouter([{ path: "*", element: <FileSearchResults results={{ q: "li", results: [{ path: "src/lib", name: "lib", kind: "dir" }, { path: "README.md", name: "README.md", kind: "file" }], truncated: false }} /> }], { initialEntries: ["/files"] });
    render(<RouterProvider router={router} />);
    fireEvent.contextMenu(screen.getByText("lib"));
    const link = await screen.findByRole("link", { name: /Download/ });
    expect(link).toHaveAttribute("href", "/api/files/download?path=src%2Flib");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.contextMenu(screen.getByText("README.md"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("removes deleted root and nested rows, including after stale-root remount", async () => {
    const root = dir("", [{ name: "README.md", kind: "file", size: 1, mtimeMs: 1 }, { name: "src", kind: "dir", mtimeMs: 1 }]);
    server.use(http.get("/api/files", ({ request }) => new URL(request.url).searchParams.get("path") === "src" ? HttpResponse.json(dir("src", [{ name: "notes.md", kind: "file", size: 1, mtimeMs: 1 }])) : HttpResponse.json(root)));
    renderTree(root); await act(async () => { noteDeletedFile("README.md"); }); expect(screen.queryByText("README.md")).toBeNull();
    fireEvent.click(screen.getByText("src")); expect(await screen.findByText("notes.md")).toBeInTheDocument();
    await act(async () => { noteDeletedFile("src/notes.md"); }); expect(screen.queryByText("notes.md")).toBeNull(); expect(screen.getByText("src")).toBeInTheDocument(); cleanup(); renderTree(dir("", [{ name: "README.md", kind: "file", size: 1, mtimeMs: 1 }, { name: "src", kind: "dir", mtimeMs: 1 }]));
    expect(screen.queryByText("README.md")).toBeNull();
  });

  it("filters deleted search hits at render", () => {
    noteDeletedFile("README.md");
    const router = createMemoryRouter([{ path: "*", element: <FileSearchResults results={{ q: "read", results: [{ path: "README.md", name: "README.md", kind: "file" }], truncated: false }} /> }], { initialEntries: ["/files"] });
    render(<RouterProvider router={router} />); expect(screen.queryByText("README.md")).toBeNull();
  });

  it("renders the supplied root without fetching it", () => {
    const handler = () => HttpResponse.json(dir("", [{ name: "wrong", kind: "file", size: 1, mtimeMs: 1 }]));
    server.use(http.get("/api/files", handler));
    renderTree(dir("", [{ name: "src", kind: "dir", mtimeMs: 1 }, { name: "README.md", kind: "file", size: 1, mtimeMs: 1 }]));
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });
  it("fetches an expanded folder once and reuses its listing", async () => {
    const handler = vi.fn(() => HttpResponse.json(dir("src", [{ name: "nav.ts", kind: "file", size: 1, mtimeMs: 1 }])));
    server.use(http.get("/api/files", handler));
    renderTree(dir("", [{ name: "src", kind: "dir", mtimeMs: 1 }]));
    fireEvent.click(screen.getByText("src"));
    expect(await screen.findByText("nav.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("nav.ts")).toBeInTheDocument());
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("shows truncation and selects files", () => {
    renderTree({ kind: "dir", path: "", entries: [{ name: "a.txt", kind: "file", size: 1, mtimeMs: 1 }], truncated: true }, "a.txt");
    expect(screen.getByText("listing truncated")).toBeInTheDocument();
    expect(screen.getByText("a.txt").closest("button")).toHaveAttribute("aria-current", "page");
  });
  it("opens a file", async () => {
    const router = renderTree(dir("", [{ name: "a.txt", kind: "file", size: 1, mtimeMs: 1 }]));
    fireEvent.click(screen.getByText("a.txt"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/files/a.txt"));
    expect(router.state.location.search).toBe("");
  });
  it("moves the active row and opens a file with desktop keys", async () => {
    setDesktop(true);
    const router = renderTree(dir("", [{ name: "a.txt", kind: "file", size: 1, mtimeMs: 1 }, { name: "b.txt", kind: "file", size: 1, mtimeMs: 1 }]));
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(tree).toHaveAttribute("aria-activedescendant", "files-row-0");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(tree).toHaveAttribute("aria-activedescendant", "files-row-1");
    fireEvent.keyDown(tree, { key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/files/b.txt"));
  });
  it("does not handle tree keys on phone", () => {
    const router = renderTree(dir("", [{ name: "a.txt", kind: "file", size: 1, mtimeMs: 1 }]));
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    expect(router.state.location.pathname).toBe("/files");
  });
  describe("desktop keyboard", () => {
    it("moves up, expands and steps into folders, collapses and returns to the parent", async () => {
      setDesktop(true);
      server.use(http.get("/api/files", ({ request }) => {
        const path = new URL(request.url).searchParams.get("path") ?? "";
        return HttpResponse.json(path === "src"
          ? dir(path, [{ name: "nav.ts", kind: "file", size: 1, mtimeMs: 1 }])
          : dir(path, [{ name: "src", kind: "dir", mtimeMs: 1 }, { name: "README.md", kind: "file", size: 1, mtimeMs: 1 }]));
      }));
      renderTree(dir("", [{ name: "src", kind: "dir", mtimeMs: 1 }, { name: "README.md", kind: "file", size: 1, mtimeMs: 1 }]));
      const tree = screen.getByRole("tree");

      fireEvent.keyDown(tree, { key: "ArrowUp" });
      expect(tree).toHaveAttribute("aria-activedescendant", "files-row-1");
      fireEvent.keyDown(tree, { key: "ArrowUp" });
      expect(tree).toHaveAttribute("aria-activedescendant", "files-row-0");
      fireEvent.keyDown(tree, { key: "ArrowRight" });
      expect(await screen.findByText("nav.ts")).toBeInTheDocument();
      expect(tree).toHaveAttribute("aria-activedescendant", "files-row-0");
      fireEvent.keyDown(tree, { key: "ArrowRight" });
      expect(tree).toHaveAttribute("aria-activedescendant", "files-row-1");
      fireEvent.keyDown(tree, { key: "ArrowLeft" });
      expect(tree).toHaveAttribute("aria-activedescendant", "files-row-0");
      fireEvent.keyDown(tree, { key: "ArrowLeft" });
      expect(screen.queryByText("nav.ts")).toBeNull();
      expect(tree).toHaveAttribute("aria-activedescendant", "files-row-0");
    });

    it("opens files with Enter and ignores modified arrows", async () => {
      setDesktop(true);
      const router = renderTree(dir("", [{ name: "a.txt", kind: "file", size: 1, mtimeMs: 1 }, { name: "b.txt", kind: "file", size: 1, mtimeMs: 1 }]));
      const tree = screen.getByRole("tree");
      fireEvent.keyDown(tree, { key: "ArrowDown" });
      expect(tree).toHaveAttribute("aria-activedescendant", "files-row-0");
      fireEvent.keyDown(tree, { key: "ArrowDown", ctrlKey: true });
      expect(tree).toHaveAttribute("aria-activedescendant", "files-row-0");
      fireEvent.keyDown(tree, { key: "Enter" });
      await waitFor(() => expect(router.state.location.pathname).toBe("/files/a.txt"));
      expect(router.state.location.search).toBe("");
    });
  });

  it("has no desktop tree keyboard affordances on a phone", () => {
    renderTree(dir("", [{ name: "a.txt", kind: "file", size: 1, mtimeMs: 1 }]));
    const tree = screen.getByRole("tree");
    expect(tree).not.toHaveAttribute("tabindex");
    expect(tree).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(tree).not.toHaveAttribute("aria-activedescendant");
  });

  it("fetches persisted open folders on first paint", async () => {
    open("src");
    server.use(http.get("/api/files", ({ request }) => HttpResponse.json(dir(new URL(request.url).searchParams.get("path") ?? "", [{ name: "nav.ts", kind: "file", size: 1, mtimeMs: 1 }]))));
    renderTree(dir("", [{ name: "src", kind: "dir", mtimeMs: 1 }]));
    expect(await screen.findByText("nav.ts")).toBeInTheDocument();
  });
});

describe("repo indicator", () => {
  beforeEach(() => { __resetFilesTree(); __resetDesktop(); });
  afterEach(() => { __resetFilesTree(); __resetDesktop(); });
  it("marks folders the bridge flags as checkouts, and only those", async () => {
    renderTree(dir("", [{ name: "sightr", kind: "dir", mtimeMs: 1, repo: true }, { name: "notes", kind: "dir", mtimeMs: 1 }, { name: "README.md", kind: "file", size: 1, mtimeMs: 1 }]));
    const marks = await screen.findAllByLabelText("git checkout"); expect(marks).toHaveLength(1);
    expect(marks[0]!.closest("[role=treeitem]")).toHaveTextContent("sightr");
  });
});
