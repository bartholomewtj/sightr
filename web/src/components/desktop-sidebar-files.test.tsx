import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { DesktopSidebar } from "./desktop-sidebar";
import { sidebarSlot, filesRelFromPath, isTracesDest, FILES_FIND_ID, FILES_TREE_ID } from "./desktop-sidebar-slot";
import { __resetDesktop, setDesktop } from "@/lib/desktop";
import { __resetFilesTree } from "@/lib/files-tree";
import type { HomeData } from "@/lib/loaders";

const data: HomeData = { bridge: "connected", device: undefined, agents: [], shellPanes: [], workspaces: [], tabs: [], files: true, error: false, authError: false };
function renderSidebar(path: string, value = data) {
  const router = createMemoryRouter([{ path: "*", element: <DesktopSidebar data={value} /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("desktop sidebar Files slot", () => {
  beforeEach(() => { __resetDesktop(); setDesktop(true); __resetFilesTree(); });
  afterEach(() => { __resetDesktop(); __resetFilesTree(); });
  it.each([
    ["/", "spaces"], ["/settings", "spaces"], ["/pane/a", "spaces"], ["/traces/a/r?pane=p", "spaces"], ["/files", "files"], ["/files/a.txt", "files"], ["/traces", "traces"], ["/traces/a/r", "traces"],
  ])("maps %s to %s", (path, expected) => expect(sidebarSlot(path.split("?")[0]!, path.includes("?") ? `?${path.split("?")[1]}` : "")).toBe(expected));
  it.each([
    ["/", "", false],
    ["/traces", "", true],
    ["/traces/w1/sightr", "", true],
    ["/traces/w1/sightr", "?pane=w1:p1", false],
    ["/files", "", false],
  ])("isTracesDest(%s %s) is %s", (path, search, expected) => expect(isTracesDest(path, search)).toBe(expected));
  it("decodes file paths", () => {
    expect(filesRelFromPath("/files")).toBe("");
    expect(filesRelFromPath("/files/src/nav.ts")).toBe("src/nav.ts");
    expect(filesRelFromPath("/files/a%20b/c.txt")).toBe("a b/c.txt");
  });
  it("shows Files search and tree instead of SpaceTree", async () => {
    server.use(http.get("/api/files", () => HttpResponse.json({ kind: "dir", path: "", entries: [{ name: "src", kind: "dir" }], truncated: false })));
    renderSidebar("/files");
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveAttribute("id", FILES_FIND_ID);
    expect(screen.queryByLabelText("New space")).toBeNull();
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Sightr")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Desktop navigation" })).toBeInTheDocument();
  });
  it.each(["/", "/settings", "/pane/a"])("shows SpaceTree on %s", (path) => {
    renderSidebar(path);
    expect(screen.getByLabelText("New space")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
  it("falls back to SpaceTree when Files is disabled", () => {
    renderSidebar("/files", { ...data, files: false });
    expect(screen.getByLabelText("New space")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
  });
  it("Esc clears Find files and returns focus to the tree", async () => {
    server.use(
      http.get("/api/files", () => HttpResponse.json({ kind: "dir", path: "", entries: [{ name: "src", kind: "dir" }], truncated: false })),
      http.get("/api/files/search", () => HttpResponse.json({ q: "needle", results: [{ path: "found.ts", name: "found.ts", kind: "file" }], truncated: false })),
    );
    renderSidebar("/files");
    const input = await screen.findByRole("searchbox");
    fireEvent.change(input, { target: { value: "needle" } });
    expect(await screen.findByText("found.ts")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.queryByText("found.ts")).toBeNull();
    expect(document.activeElement).toBe(document.getElementById(FILES_TREE_ID));
    expect(document.getElementById(FILES_FIND_ID)).toBe(input);
  });
  it("expands a folder by name and navigates", async () => {
    server.use(http.get("/api/files", ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      return HttpResponse.json(path === "src"
        ? { kind: "dir", path, entries: [{ name: "nav.ts", kind: "file", size: 10, mtimeMs: 1 }], truncated: false }
        : { kind: "dir", path: "", entries: [{ name: "src", kind: "dir", mtimeMs: 1 }], truncated: false });
    }));
    const router = renderSidebar("/files");
    fireEvent.click(await screen.findByText("src"));
    expect(await screen.findByText("nav.ts")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/files/src"));
  });
  it("toggles a folder with the chevron without navigating", async () => {
    server.use(http.get("/api/files", ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      return HttpResponse.json(path === "src"
        ? { kind: "dir", path, entries: [{ name: "nav.ts", kind: "file" }], truncated: false }
        : { kind: "dir", path: "", entries: [{ name: "src", kind: "dir" }], truncated: false });
    }));
    const router = renderSidebar("/files");
    fireEvent.click(await screen.findByLabelText("Expand src"));
    expect(await screen.findByText("nav.ts")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/files");
    fireEvent.click(screen.getByLabelText("Collapse src"));
    await waitFor(() => expect(screen.queryByText("nav.ts")).toBeNull());
    expect(router.state.location.pathname).toBe("/files");
  });
  it("opens a file and keeps the tree rows", async () => {
    server.use(http.get("/api/files", ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      return HttpResponse.json(path === "src"
        ? { kind: "dir", path, entries: [{ name: "nav.ts", kind: "file" }], truncated: false }
        : { kind: "dir", path: "", entries: [{ name: "src", kind: "dir" }], truncated: false });
    }));
    const router = renderSidebar("/files");
    fireEvent.click(await screen.findByLabelText("Expand src"));
    const file = await screen.findByText("nav.ts");
    fireEvent.click(file);
    await waitFor(() => expect(router.state.location.pathname).toBe("/files/src/nav.ts"));
    expect(screen.getByRole("tree")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("nav.ts")).toBeInTheDocument();
  });
});
