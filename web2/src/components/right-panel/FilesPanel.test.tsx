import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { FilesResponse } from "@shared/wire";
import { threadFromSnapshot } from "@/stream/apply";
import { useBridgeInfo, useThreadStore } from "@/stream/stores";
import { thread, threadSnapshot } from "@/test/fixtures";
import { server } from "@/test/setup";

import { FilesPanel } from "./FilesPanel";

const dir = (path: string, entries: { name: string; kind: "dir" | "file" }[]): FilesResponse => ({
  kind: "dir",
  path,
  truncated: false,
  entries: entries.map((e) => ({ ...e, mtimeMs: 1 })),
});
const file = (path: string, text: string): FilesResponse => ({
  kind: "file",
  path,
  name: path.split("/").pop()!,
  size: text.length,
  mtimeMs: 7,
  binary: false,
  text,
});

const FILES: Record<string, FilesResponse> = {
  proj: dir("proj", [
    { name: "src", kind: "dir" },
    { name: "a.txt", kind: "file" },
  ]),
  "proj/src": dir("proj/src", [{ name: "main.ts", kind: "file" }]),
  "proj/a.txt": file("proj/a.txt", "hello"),
  "proj/src/main.ts": file("proj/src/main.ts", "export {};"),
};

let saves: unknown[] = [];
let deletes: unknown[] = [];

beforeEach(() => {
  saves = [];
  deletes = [];
  server.use(
    http.get("/api/files/pane-folder", () => HttpResponse.json({ path: "proj" })),
    http.get("/api/files/search", ({ request }) => {
      const q = new URL(request.url).searchParams.get("q");
      return HttpResponse.json({ q, truncated: false, results: [{ path: "proj/src/main.ts", name: "main.ts", kind: "file" }] });
    }),
    http.get("/api/files", ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      const body = FILES[path];
      return body ? HttpResponse.json(body) : new HttpResponse("not found", { status: 404 });
    }),
    http.post("/api/files/save", async ({ request }) => {
      saves.push(await request.json());
      return HttpResponse.json({ ok: true, mtimeMs: 9, size: 5 });
    }),
    http.post("/api/files/delete", async ({ request }) => {
      deletes.push(await request.json());
      return HttpResponse.json({ ok: true });
    }),
    http.get("/api/local-servers", () => HttpResponse.json({ host: "pc.tail.ts.net", servers: [{ port: 5173, name: "vite" }] })),
  );
  act(() => useThreadStore.setState({ current: threadFromSnapshot(threadSnapshot(3, thread("t1")), false), missing: null }));
});

describe("FilesPanel", () => {
  it("lists the thread's folder and expands a folder in place", async () => {
    render(<FilesPanel threadId="t1" />);
    expect(await screen.findByRole("treeitem", { name: /a\.txt/ })).toBeInTheDocument();
    expect(document.querySelector("[data-files-base]")).toHaveAttribute("data-files-base", "proj");
    fireEvent.click(screen.getByRole("treeitem", { name: /src/ }));
    expect(await screen.findByRole("treeitem", { name: /main\.ts/ })).toBeInTheDocument();
  });

  it("searches and opens a result", async () => {
    render(<FilesPanel threadId="t1" />);
    fireEvent.change(await screen.findByRole("searchbox", { name: "Find files" }), { target: { value: "main" } });
    fireEvent.click(await screen.findByRole("button", { name: /main\.ts/ }));
    expect(await screen.findByText("export {};")).toBeInTheDocument();
  });

  it("previews text, and edits with a dirty guard on leaving", async () => {
    render(<FilesPanel threadId="t1" />);
    fireEvent.click(await screen.findByRole("treeitem", { name: /a\.txt/ }));
    expect(await screen.findByText("hello")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit a.txt"), { target: { value: "hello!" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    const guard = await screen.findByRole("alertdialog", { name: "Unsaved edits" });
    fireEvent.click(within(guard).getByRole("button", { name: "Stay" }));
    expect(screen.getByLabelText("Edit a.txt")).toHaveValue("hello!");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saves).toEqual([{ path: "proj/a.txt", text: "hello!", mtimeMs: 7 }]));
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    expect(await screen.findByRole("treeitem", { name: /a\.txt/ })).toBeInTheDocument();
  });

  it("discards dirty edits when asked", async () => {
    render(<FilesPanel threadId="t1" />);
    fireEvent.click(await screen.findByRole("treeitem", { name: /a\.txt/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit a.txt"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard edits" }));
    expect(await screen.findByRole("treeitem", { name: /a\.txt/ })).toBeInTheDocument();
    expect(saves).toHaveLength(0);
  });

  it("deletes on the second tap only", async () => {
    render(<FilesPanel threadId="t1" />);
    fireEvent.click(await screen.findByRole("treeitem", { name: /a\.txt/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(deletes).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Really delete a.txt?" }));
    await waitFor(() => expect(deletes).toEqual([{ path: "proj/a.txt" }]));
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: /a\.txt/ })).toBeNull());
    expect(screen.getByRole("treeitem", { name: /src/ })).toBeInTheDocument();
  });

  it("gives a read-only device neither edit nor delete", async () => {
    act(() => useBridgeInfo.setState({ readOnly: true }));
    render(<FilesPanel threadId="t1" />);
    fireEvent.click(await screen.findByRole("treeitem", { name: /a\.txt/ }));
    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("link", { name: /Download/ })).toHaveAttribute("href", "/api/files/download?path=proj%2Fa.txt");
  });

  it("lists the servers on this PC", async () => {
    render(<FilesPanel threadId="t1" />);
    const section = await screen.findByRole("region", { name: "Servers on this PC" });
    expect(await within(section).findByRole("link", { name: /vite/ })).toHaveAttribute("href", "http://pc.tail.ts.net:5173/");
  });

  it("says when Files is off", async () => {
    server.use(http.get("/api/files/pane-folder", () => new HttpResponse("not found", { status: 404 })));
    render(<FilesPanel threadId="t1" />);
    expect(await screen.findByText(/Files isn't turned on/)).toBeInTheDocument();
  });
});
