import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { FilesRoute } from "./files";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import type { HomeData } from "@/lib/loaders";
import { __resetFilesTree } from "@/lib/files-tree";
import { clearStatus } from "@/lib/status";
import { __resetDesktop, setDesktop } from "@/lib/desktop";

const home: HomeData = { bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], device: undefined, files: true, error: false, authError: false };
function renderFiles(data: unknown, root = home, opts: { initialEntries?: string[] } = {}) {
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => root, element: <Outlet />, children: [{ path: "files", loader: () => data, element: <FilesRoute /> }, { path: "files/*", loader: () => data, element: <FilesRoute /> }] }], { initialEntries: opts.initialEntries ?? ["/files"] });
  render(<RouterProvider router={router} />); return router;
}

/** FileDetail's mount effect resets `editing`. A click on the first paint is lost on slow CI. */
async function clickEdit() {
  await screen.findByRole("button", { name: "Edit" });
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  return screen.findByRole("textbox", {}, { timeout: 5000 });
}

describe("FilesRoute", () => {
  beforeEach(() => { __resetFilesTree(); clearStatus(); });
  afterEach(() => { __resetFilesTree(); clearStatus(); });
  describe("desktop", () => {
    beforeEach(() => setDesktop(true));
    afterEach(() => __resetDesktop());
    it("shows Pick a file without the phone tree or search", async () => {
      renderFiles({ rel: "", data: { kind: "dir", path: "", entries: [], truncated: false } });
      expect(await screen.findByText("Pick a file")).toBeInTheDocument();
      expect(screen.queryByRole("searchbox")).toBeNull();
      expect(screen.queryByRole("tree")).toBeNull();
      expect(screen.queryByLabelText("Back")).toBeNull();
    });
    it("shows Pick a file for a selected folder without the phone tree", async () => {
      renderFiles({ rel: "src", data: { kind: "dir", path: "src", entries: [], truncated: false } });
      expect(await screen.findByText("Pick a file")).toBeInTheDocument();
      expect(screen.queryByRole("tree")).toBeNull();
      expect(screen.queryByLabelText("Back")).toBeNull();
    });
    it("shows the status line on a failed save", async () => {
      server.use(http.post("/api/files/save", () => HttpResponse.json({ ok: false, error: "file changed" }, { status: 409 })));
      renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 4, mtimeMs: 1, binary: false, text: "hello" } });
      // Wait for the loaded preview before clicking Edit: the router renders once before hydration
      // settles and once after, and an Edit clicked on the first render is lost with it on a slow CI box.
      expect(await screen.findByText("hello")).toBeInTheDocument();
      fireEvent.change(await clickEdit(), { target: { value: "draft" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("File changed on disk — not saved"));
    });
    it("shows a file preview without a back button", async () => {
      renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 4, mtimeMs: 1, binary: false, text: "hello" } });
      expect(await screen.findByText("hello")).toBeInTheDocument();
      expect(screen.getByText("Copy path")).toBeInTheDocument();
      expect(screen.queryByLabelText("Back")).toBeNull();
    });
    it("renders Git on the Files root", async () => {
      renderFiles({ rel: "", data: { kind: "dir", path: "", entries: [], truncated: false } });
      expect(await screen.findByRole("button", { name: /Git.*Files root/ })).toBeEnabled();
    });
    it("renders Git on a selected folder", async () => {
      renderFiles({ rel: "Projects/tools/sightr", data: { kind: "dir", path: "Projects/tools/sightr", entries: [], truncated: false } });
      expect(await screen.findByRole("button", { name: /Git/ })).toBeInTheDocument();
    });
    it("renders Git on the Files root for the focused pane", async () => {
      const focused = { ...home, agents: [{ paneId: "p1", workspaceId: "w", workspaceLabel: "Work", workspaceNumber: 1, tabId: "t", agent: "claude", status: "idle" as const, cwd: "/work/repo", focused: true }] };
      renderFiles({ rel: "", data: { kind: "dir", path: "", entries: [], truncated: false } }, focused);
      expect(await screen.findByRole("button", { name: /Git/ })).toBeInTheDocument();
    });
    it("does not render Git on a file preview", () => {
      const focused = { ...home, agents: [{ paneId: "p1", workspaceId: "w", workspaceLabel: "Work", workspaceNumber: 1, tabId: "t", agent: "claude", status: "idle" as const, cwd: "/work/repo", focused: true }] };
      renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 4, mtimeMs: 1, binary: false, text: "hello" } }, focused);
      expect(screen.queryByRole("button", { name: /Git/ })).toBeNull();
    });
  });
  it("renders the Git row on the phone Files root", async () => {
    renderFiles({ rel: "", data: { kind: "dir", path: "", entries: [], truncated: false } });
    expect(await screen.findByRole("button", { name: /Git.*Files root/ })).toBeEnabled();
  });
  it("renders Git on the phone for a selected folder", async () => {
    renderFiles({ rel: "Projects/tools/sightr", data: { kind: "dir", path: "Projects/tools/sightr", entries: [], truncated: false } });
    expect(await screen.findByRole("button", { name: /Git/ })).toBeInTheDocument();
  });
  it("expands a folder in place and leaves the URL alone", async () => {
    server.use(http.get("/api/files", ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      return HttpResponse.json(path === "src" ? { kind: "dir", path, entries: [{ name: "nav.ts", kind: "file", size: 10, mtimeMs: 1 }], truncated: false } : { kind: "dir", path: "", entries: [{ name: "src", kind: "dir", mtimeMs: 1 }], truncated: false });
    }));
    const router = renderFiles({ rel: "", data: { kind: "dir", path: "", entries: [{ name: "src", kind: "dir", mtimeMs: 1 }], truncated: false } });
    fireEvent.click(await screen.findByText("src"));
    expect(await screen.findByText("nav.ts")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/files");
  });
  it("phone Git follows a tapped folder and returns to Files root when that folder closes", async () => {
    server.use(http.get("/api/files", ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      return HttpResponse.json(path === "src" ? { kind: "dir", path, entries: [{ name: "nav.ts", kind: "file", size: 10, mtimeMs: 1 }], truncated: false } : { kind: "dir", path: "", entries: [{ name: "src", kind: "dir", mtimeMs: 1 }], truncated: false });
    }));
    const router = renderFiles({ rel: "", data: { kind: "dir", path: "", entries: [{ name: "src", kind: "dir", mtimeMs: 1 }], truncated: false } });
    expect(await screen.findByRole("button", { name: /Git.*Files root/ })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("treeitem", { name: /src/ }));
    expect(await screen.findByRole("button", { name: /Git.*src/ })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/files");
    fireEvent.click(screen.getByRole("treeitem", { name: /src/ }));
    expect(await screen.findByRole("button", { name: /Git.*Files root/ })).toBeInTheDocument();
  });
  it("walks a nested folder in place and opens a file", async () => {
    server.use(http.get("/api/files", ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      const entries = path === "" ? [{ name: "src", kind: "dir" }] : path === "src" ? [{ name: "lib", kind: "dir" }] : [{ name: "nav.ts", kind: "file", size: 10 }];
      return HttpResponse.json({ kind: "dir", path, entries, truncated: false });
    }));
    const router = renderFiles({ rel: "", data: { kind: "dir", path: "", entries: [{ name: "src", kind: "dir", mtimeMs: 1 }], truncated: false } });
    fireEvent.click(await screen.findByText("src"));
    fireEvent.click(await screen.findByText("lib"));
    expect(await screen.findByText("nav.ts")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/files");
    fireEvent.click(screen.getByText("nav.ts"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/files/src/lib/nav.ts"));
  });
  it("debounces filename search", async () => {
    vi.useFakeTimers(); const search = vi.fn(() => HttpResponse.json({ q: "abc", results: [{ path: "abc.txt", name: "abc.txt", kind: "file" }], truncated: false }));
    server.use(http.get("/api/files/search", search));
    renderFiles({ rel: "", data: { kind: "dir", path: "", entries: [], truncated: false } });
    await act(async () => { await Promise.resolve(); }); const input = screen.getByRole("searchbox"); fireEvent.change(input, { target: { value: "abc" } }); await act(async () => { vi.advanceTimersByTime(200); await vi.runOnlyPendingTimersAsync(); await Promise.resolve(); });
    vi.useRealTimers(); await waitFor(() => expect(screen.getByText("abc.txt")).toBeInTheDocument()); expect(search).toHaveBeenCalledTimes(1);
  });
  it("offers delete for text previews and not binary previews", async () => {
    for (const [name, data] of [["readme.md", { binary: false, text: "x" }], ["readme.txt", { binary: false, text: "x" }], ["page.html", { binary: false, text: "x" }]] as const) { cleanup(); renderFiles({ rel: name, data: { kind: "file", path: name, name, size: 1, mtimeMs: 1, ...data } }, home, { initialEntries: ["/files", `/files/${name}`] }); expect(await screen.findByText("Delete")).toBeInTheDocument(); }
    for (const name of ["shot.png", "clip.mp4", "track.mp3", "bin.dat"]) { cleanup(); renderFiles({ rel: name, data: { kind: "file", path: name, name, size: 1, mtimeMs: 1, binary: true } }, home, { initialEntries: ["/files", `/files/${name}`] }); expect(screen.queryByText("Delete")).toBeNull(); }
  });

  it("shows Edit only for editable text previews", async () => {
    for (const name of ["readme.md", "readme.txt", "page.html"]) { cleanup(); renderFiles({ rel: name, data: { kind: "file", path: name, name, size: 1, mtimeMs: 1, binary: false, text: "x" } }, home, { initialEntries: ["/files", `/files/${name}`] }); expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument(); expect(screen.getByText("Delete")).toBeInTheDocument(); }
    for (const name of ["shot.png", "bin.dat", "clip.mp4", "track.mp3"]) { cleanup(); renderFiles({ rel: name, data: { kind: "file", path: name, name, size: 1, mtimeMs: 1, binary: true } }, home, { initialEntries: ["/files", `/files/${name}`] }); expect(screen.queryByRole("button", { name: "Edit" })).toBeNull(); }
  });
  it("hides Edit for truncated and read-only text previews", async () => {
    renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 1, mtimeMs: 1, binary: false, truncated: true, text: "x" } }, home, { initialEntries: ["/files", "/files/readme.txt"] }); await screen.findByText("x", { selector: "pre" }); expect(screen.queryByRole("button", { name: "Edit" })).toBeNull(); expect(screen.getByText(/truncated/)).toBeInTheDocument(); expect(screen.getByText("Delete")).toBeInTheDocument(); cleanup(); const readOnly = { ...home, device: { enforced: true, authorized: false, device: null } }; renderFiles({ rel: "readme.md", data: { kind: "file", path: "readme.md", name: "readme.md", size: 1, mtimeMs: 1, binary: false, text: "x" } }, readOnly, { initialEntries: ["/files", "/files/readme.md"] }); expect(screen.queryByRole("button", { name: "Edit" })).toBeNull(); expect(screen.queryByText("Delete")).toBeNull(); expect(await screen.findByText("Copy path")).toBeInTheDocument(); expect(screen.getByText("Download")).toBeInTheDocument();
  });
  it("enters editing in the expected order and discards without saving", async () => {
    const post = vi.fn(); server.use(http.post("/api/files/save", async ({ request }) => { post(await request.json()); return HttpResponse.json({ ok: true, mtimeMs: 2, size: 3 }); })); renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 5, mtimeMs: 1, binary: false, text: "hello" } }, home, { initialEntries: ["/files", "/files/readme.txt"] }); const editor = await clickEdit(); const save = screen.getByRole("button", { name: "Save" }); expect(editor).toHaveValue("hello"); expect(screen.queryByText("hello", { selector: "pre" })).toBeNull(); expect(save).toBeDisabled(); expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument(); expect(screen.queryByText("Delete")).toBeNull(); expect(save.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); fireEvent.change(editor, { target: { value: "new" } }); expect(save).not.toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Discard" })); expect(screen.getByText("hello", { selector: "pre" })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument(); expect(screen.getByText("Delete")).toBeInTheDocument(); expect(post).not.toHaveBeenCalled();
  });
  it("saves twice using the returned mtime", async () => {
    const bodies: unknown[] = []; server.use(http.post("/api/files/save", async ({ request }) => { bodies.push(await request.json()); return HttpResponse.json({ ok: true, mtimeMs: 2, size: 3 }); })); const router = renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 5, mtimeMs: 1, binary: false, text: "hello" } }, home, { initialEntries: ["/files", "/files/readme.txt"] }); fireEvent.change(await clickEdit(), { target: { value: "new" } }); fireEvent.click(screen.getByRole("button", { name: "Save" })); await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved")); expect(router.state.location.pathname).toBe("/files/readme.txt"); expect(screen.getByText("new", { selector: "pre" })).toBeInTheDocument(); fireEvent.change(await clickEdit(), { target: { value: "newer" } }); fireEvent.click(screen.getByRole("button", { name: "Save" })); await waitFor(() => expect(bodies).toHaveLength(2)); expect(bodies[1]).toMatchObject({ mtimeMs: 2 });
  });
  it("renders a markdown file formatted, and raw again while editing", async () => {
    renderFiles({ rel: "notes.md", data: { kind: "file", path: "notes.md", name: "notes.md", size: 30, mtimeMs: 1, binary: false, text: "# Title\n\nSome **bold** text" } }, home, { initialEntries: ["/files", "/files/notes.md"] });
    expect(await screen.findByText("Title")).toBeInTheDocument(); expect(screen.getByText("bold", { selector: "strong" })).toBeInTheDocument(); expect(screen.queryByText(/# Title/, { selector: "pre" })).toBeNull();
    expect(await clickEdit()).toHaveValue("# Title\n\nSome **bold** text"); expect(screen.queryByText("bold", { selector: "strong" })).toBeNull();
  });
  it.each([["file changed", "File changed on disk — not saved"], ["file is in use", "file is in use"]])("keeps the draft on 409 %s", async (error, message) => { server.use(http.post("/api/files/save", () => HttpResponse.json({ ok: false, error }, { status: 409 }))); renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 5, mtimeMs: 1, binary: false, text: "hello" } }, home, { initialEntries: ["/files", "/files/readme.txt"] }); fireEvent.change(await clickEdit(), { target: { value: "draft" } }); fireEvent.click(screen.getByRole("button", { name: "Save" })); await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message)); expect(screen.getByRole("textbox")).toHaveValue("draft"); if (error === "file changed") expect(screen.getByRole("status")).not.toHaveTextContent("file is in use"); });
  it.each([[413, "file too large"], [403, "forbidden"]])("keeps editing on save status %s", async (status, message) => { server.use(http.post("/api/files/save", () => status === 413 ? HttpResponse.json({ error: message }, { status }) : new HttpResponse(message, { status }))); renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 5, mtimeMs: 1, binary: false, text: "hello" } }, home, { initialEntries: ["/files", "/files/readme.txt"] }); fireEvent.change(await clickEdit(), { target: { value: "draft" } }); fireEvent.click(screen.getByRole("button", { name: "Save" })); await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message)); expect(screen.getByRole("textbox")).toHaveValue("draft"); expect(screen.getByRole("status")).not.toHaveTextContent("/api/files/save → 413"); });
  it("blocks dirty back and navigation, and supports stay or discard", async () => {
    const router = renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 5, mtimeMs: 1, binary: false, text: "hello" } }, home, { initialEntries: ["/files", "/files/readme.txt"] }); fireEvent.change(await clickEdit(), { target: { value: "draft" } }); fireEvent.click(screen.getByLabelText("Back")); expect(router.state.location.pathname).toBe("/files/readme.txt"); expect(screen.getByText("Stay")).toBeInTheDocument(); expect(screen.getByText("Discard edits")).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Save" })).toBeNull(); fireEvent.click(screen.getByText("Stay")); expect(screen.getByRole("textbox")).toHaveValue("draft"); expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument(); fireEvent.click(screen.getByLabelText("Back")); fireEvent.click(screen.getByText("Discard edits")); await waitFor(() => expect(router.state.location.pathname).toBe("/files"));
  });
  it("returns immediately on clean phone Back", async () => {
    const router = renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 4, mtimeMs: 1, binary: false, text: "hello" } }, home, { initialEntries: ["/files", "/files/readme.txt"] });
    fireEvent.click(await screen.findByLabelText("Back")); await waitFor(() => expect(router.state.location.pathname).toBe("/files"));
  });

  it("blocks dirty in-app navigation and supports stay or discard", async () => {
    const router = renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 5, mtimeMs: 1, binary: false, text: "hello" } }, home, { initialEntries: ["/files", "/files/readme.txt"] });
    fireEvent.change(await clickEdit(), { target: { value: "draft" } });
    await act(async () => { await router.navigate("/files/other.md"); }); expect(screen.getByText("Stay")).toBeInTheDocument(); fireEvent.click(screen.getByText("Stay")); expect(screen.getByRole("textbox")).toHaveValue("draft");
    await act(async () => { await router.navigate("/files/other.md"); }); fireEvent.click(screen.getByText("Discard edits")); await waitFor(() => expect(router.state.location.pathname).toBe("/files/other.md"));
  });

  it("saves dirty edits with Ctrl+S and Cmd+S, but prevents clean Ctrl+S", async () => {
    let calls = 0; server.use(http.post("/api/files/save", () => { calls++; return HttpResponse.json({ ok: true, mtimeMs: 2, size: 5 }); })); renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 5, mtimeMs: 1, binary: false, text: "hello" } }, home, { initialEntries: ["/files", "/files/readme.txt"] }); const editor = await clickEdit(); const clean = fireEvent.keyDown(editor, { key: "s", ctrlKey: true }); expect(clean).toBe(false); expect(calls).toBe(0); fireEvent.change(editor, { target: { value: "draft" } }); fireEvent.keyDown(editor, { key: "s", ctrlKey: true }); await waitFor(() => expect(calls).toBe(1)); const editor2 = await clickEdit(); fireEvent.change(editor2, { target: { value: "draft2" } }); fireEvent.keyDown(editor2, { key: "s", metaKey: true }); await waitFor(() => expect(calls).toBe(2));
  });

  it("edits and saves a text preview without leaving its URL", async () => {
    let body: unknown;
    server.use(http.post("/api/files/save", async ({ request }) => { body = await request.json(); return HttpResponse.json({ ok: true, mtimeMs: 2, size: 7 }); }));
    const router = renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 5, mtimeMs: 1, binary: false, text: "hello" } }, home, { initialEntries: ["/files", "/files/readme.txt"] });
    const editor = await clickEdit(); const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled(); expect(screen.queryByText("Delete")).toBeNull(); fireEvent.change(editor, { target: { value: "updated" } }); expect(save).not.toBeDisabled(); fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved")); expect(router.state.location.pathname).toBe("/files/readme.txt"); expect(screen.getByText("updated")).toBeInTheDocument(); expect(body).toEqual({ path: "readme.txt", text: "updated", mtimeMs: 1 });
  });

  it("hides delete on a read-only device but keeps copy and download", async () => {
    const root = { ...home, device: { enforced: true, authorized: false, device: null } };
    renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 1, mtimeMs: 1, binary: false, text: "x" } }, root, { initialEntries: ["/files", "/files/readme.txt"] });
    expect(await screen.findByText("Copy path")).toBeInTheDocument(); expect(screen.getByText("Download")).toBeInTheDocument(); expect(screen.queryByText("Delete")).toBeNull();
  });

  it("offers two-tap delete and replaces the preview URL", async () => {
    const router = renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 4, mtimeMs: 1, binary: false, text: "hello" } }, home, { initialEntries: ["/files", "/files/readme.txt"] });
    expect(await screen.findByText("Delete")).toBeInTheDocument();
    let calls = 0; let release!: () => void; server.use(http.post("/api/files/delete", async () => { calls += 1; await new Promise<void>((resolve) => { release = resolve; }); return HttpResponse.json({ ok: true }); }));
    fireEvent.click(screen.getByText("Delete"));
    expect(calls).toBe(0); expect(screen.getByText("Really delete readme.txt?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Really delete readme.txt?"));
    await waitFor(() => expect(calls).toBe(1)); expect(await screen.findByText("Deleting…")).toBeInTheDocument(); release();
    await waitFor(() => expect(router.state.location.pathname).toBe("/files")); expect(screen.queryByText("Deleting…")).toBeNull(); router.navigate(-1); await waitFor(() => expect(router.state.location.pathname).toBe("/files"));
  });

  it("hides delete for binary files", async () => {
    renderFiles({ rel: "bin.dat", data: { kind: "file", path: "bin.dat", name: "bin.dat", size: 2, mtimeMs: 1, binary: true } });
    expect(await screen.findByText(/Can't preview/)).toBeInTheDocument();
    expect(screen.queryByText("Delete")).toBeNull();
  });

  it("stays on the preview when deletion is busy", async () => {
    server.use(http.post("/api/files/delete", () => HttpResponse.json({ ok: false, error: "file is in use" }, { status: 409 })));
    const router = renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 4, mtimeMs: 1, binary: false, text: "hello" } }, home, { initialEntries: ["/files", "/files/readme.txt"] });
    fireEvent.click(await screen.findByText("Delete")); fireEvent.click(screen.getByText("Really delete readme.txt?"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/files/readme.txt")); await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("file is in use")); expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("stays on the preview when deletion is forbidden", async () => {
    server.use(http.post("/api/files/delete", () => new HttpResponse("forbidden", { status: 403 })));
    const router = renderFiles({ rel: "readme.txt", data: { kind: "file", path: "readme.txt", name: "readme.txt", size: 4, mtimeMs: 1, binary: false, text: "hello" } }, home, { initialEntries: ["/files", "/files/readme.txt"] });
    fireEvent.click(await screen.findByText("Delete")); fireEvent.click(screen.getByText("Really delete readme.txt?"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/files/readme.txt")); await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("forbidden"));
  });

  it("shows binary download without preview and copies relative path", async () => {
    vi.useRealTimers(); const clipboard = vi.fn().mockResolvedValue(undefined); Object.assign(navigator, { clipboard: { writeText: clipboard } });
    renderFiles({ rel: "bin.dat", data: { kind: "file", path: "bin.dat", name: "bin.dat", size: 2, mtimeMs: 1, binary: true } });
    expect(await screen.findByText(/Can't preview/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Copy path")); await waitFor(() => expect(clipboard).toHaveBeenCalledWith("bin.dat")); expect(screen.getByText("Download")).toBeInTheDocument();
    expect(screen.queryByText("Open in browser")).toBeNull();
  });
  it("offers Open in browser for types Chrome can display", async () => {
    renderFiles({ rel: "shot.png", data: { kind: "file", path: "shot.png", name: "shot.png", size: 2, mtimeMs: 1, binary: true, openInBrowser: true, embed: "image" } });
    const link = await screen.findByRole("link", { name: /Open in browser/ });
    expect(link.getAttribute("href")).toBe("/api/files/open/shot.png");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("download")).toBeNull();
  });
  it("embeds an image in place", async () => {
    renderFiles({ rel: "shot.png", data: { kind: "file", path: "shot.png", name: "shot.png", size: 2, mtimeMs: 1, binary: true, openInBrowser: true, embed: "image" } });
    const img = await screen.findByRole("img", { name: "shot.png" });
    expect(img.getAttribute("src")).toBe("/api/files/open/shot.png");
  });
  it("embeds video in place", async () => {
    renderFiles({ rel: "clip.mp4", data: { kind: "file", path: "clip.mp4", name: "clip.mp4", size: 2, mtimeMs: 1, binary: true, openInBrowser: true, embed: "video" } });
    await screen.findByRole("link", { name: /Open in browser/ });
    const video = document.querySelector("video");
    expect(video?.getAttribute("src")).toBe("/api/files/open/clip.mp4");
    expect(video?.hasAttribute("controls")).toBe(true);
  });
  it("embeds audio in place", async () => {
    renderFiles({ rel: "track.mp3", data: { kind: "file", path: "track.mp3", name: "track.mp3", size: 2, mtimeMs: 1, binary: true, openInBrowser: true, embed: "audio" } });
    await screen.findByRole("link", { name: /Open in browser/ });
    expect(document.querySelector("audio")?.getAttribute("src")).toBe("/api/files/open/track.mp3");
  });
  it("does not iframe a PDF", async () => {
    renderFiles({ rel: "doc.pdf", data: { kind: "file", path: "doc.pdf", name: "doc.pdf", size: 2, mtimeMs: 1, binary: true, openInBrowser: true } });
    expect(await screen.findByText(/Can't preview this file here/)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("audio")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("link", { name: /Open in browser/ })).toBeInTheDocument();
  });
  it("offers Open in browser for HTML without iframing it", async () => {
    renderFiles({ rel: "page.html", data: { kind: "file", path: "page.html", name: "page.html", size: 12, mtimeMs: 1, binary: false, text: "<h1>hi</h1>", openInBrowser: true } });
    const link = await screen.findByRole("link", { name: /Open in browser/ });
    expect(link.getAttribute("href")).toBe("/api/files/open/page.html");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText("<h1>hi</h1>")).toBeInTheDocument();
  });
  it("opens a nested HTML file from its folder path", async () => {
    renderFiles({ rel: "site/index.html", data: { kind: "file", path: "site/index.html", name: "index.html", size: 22, mtimeMs: 1, binary: false, text: '<img src="hero.png">', openInBrowser: true } });
    const link = await screen.findByRole("link", { name: /Open in browser/ });
    expect(link.getAttribute("href")).toBe("/api/files/open/site/index.html");
  });
  it("embeds an SVG in place", async () => {
    renderFiles({ rel: "mark.svg", data: { kind: "file", path: "mark.svg", name: "mark.svg", size: 11, mtimeMs: 1, binary: false, text: "<svg></svg>", openInBrowser: true, embed: "image" } });
    const img = await screen.findByRole("img", { name: "mark.svg" });
    expect(img.getAttribute("src")).toBe("/api/files/open/mark.svg");
  });
});
