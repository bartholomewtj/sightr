import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { Thread } from "@shared/v2/contracts";
import { archivedOlderThan, groupArchived, searchArchived } from "@/lib/archived";
import { FakeEventSource } from "@/test/fake-event-source";
import { project, shellSnapshot, thread } from "@/test/fixtures";
import { frame, renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

// /archived (triage D #4): grouped by project, search, Delete (thread.delete, two taps) and
// "Clear older than N days".

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const archived = (id: string, over: Partial<Thread> = {}) =>
  thread(id, { shelf: "archived", archiveReason: "pane-closed", archivedAt: NOW - DAY, ...over });

const THREADS = [
  archived("a1", { title: "Fix the parser", projectId: "w1", archivedAt: NOW - 40 * DAY }),
  archived("a2", { title: "Write docs", projectId: "w2", archivedAt: NOW - 2 * DAY }),
  archived("a3", { title: "Parser tests", projectId: "w1", archivedAt: NOW - 60 * DAY, harness: "pi" }),
  archived("a4", { title: "Still open", projectId: "w2", archiveReason: "user", archivedAt: NOW - 90 * DAY }),
  thread("live", { title: "Active one" }),
];
const PROJECTS = [project("w1", { label: "Sightr" }), project("w2", { label: "Docs" })];

let posts: Record<string, unknown>[] = [];
beforeEach(() => {
  posts = [];
  let seq = 10;
  server.use(
    http.post("/api/v2/command", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      posts.push(body);
      // The open pane cannot be forgotten; the rest can.
      if (body.threadId === "a4") return HttpResponse.json({ ok: false, code: "conflict", error: "pane-open" }, { status: 409 });
      return HttpResponse.json({ ok: true, sequence: ++seq });
    }),
  );
});

const shell = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"))!;

async function open() {
  renderApp("/v2/archived");
  await screen.findByRole("heading", { name: "Archived", level: 1 });
  await waitFor(() => expect(shell()).toBeDefined());
  frame(() => shell().emit("snapshot", shellSnapshot(1, THREADS, PROJECTS)));
}

const deletes = () => posts.filter((p) => p.type === "thread.delete").map((p) => p.threadId);

describe("/archived", () => {
  it("groups archived threads by project, newest first, and leaves active ones out", async () => {
    await open();
    const groups = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(groups).toEqual(["Docs", "Sightr"]);
    const sightr = within(screen.getByRole("list", { name: "Archived threads in Sightr" }));
    expect(sightr.getAllByRole("link").map((l) => l.textContent)).toEqual([
      expect.stringContaining("Fix the parser"),
      expect.stringContaining("Parser tests"),
    ]);
    expect(screen.queryByText("Active one")).toBeNull();
  });

  it("searches title, project and harness", async () => {
    await open();
    const search = screen.getByLabelText("Search archived threads");
    expect(search.className).toMatch(/\btext-base\b/);
    fireEvent.change(search, { target: { value: "parser" } });
    expect(screen.getAllByRole("link", { name: /parser/i })).toHaveLength(2);
    expect(screen.queryByText("Write docs")).toBeNull();
    fireEvent.change(search, { target: { value: "docs write" } });
    expect(screen.getByText("Write docs")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "nothing like it" } });
    expect(screen.getByText("No archived thread matches.")).toBeInTheDocument();
  });

  it("Delete needs a second tap, then posts thread.delete; the stream drops the row", async () => {
    await open();
    const del = screen.getByRole("button", { name: "Delete Write docs" });
    fireEvent.click(del);
    expect(deletes()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Tap again to delete Write docs" }));
    await waitFor(() => expect(deletes()).toEqual(["a2"]));
    expect(await screen.findByText("Deleted Write docs.")).toBeInTheDocument();
    frame(() => shell().emit("event", { sequence: 2, threadId: "a2", type: "thread.deleted", payload: { at: NOW }, ts: NOW }));
    expect(screen.queryByText("Write docs")).toBeNull();
  });

  it("a pane that is still open is not deleted, and says why", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Delete Still open" }));
    fireEvent.click(screen.getByRole("button", { name: "Tap again to delete Still open" }));
    expect(await screen.findByText(/pane is still open/)).toBeInTheDocument();
  });

  it("Clear older than N days: counts, confirms, deletes each, and reports the ones kept", async () => {
    await open();
    const days = screen.getByLabelText("Clear older than");
    fireEvent.change(days, { target: { value: "30" } });
    const clear = screen.getByRole("button", { name: "Clear 3" });
    fireEvent.click(clear);
    expect(deletes()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Delete 3 threads? Tap again" }));
    await waitFor(() => expect([...deletes()].sort()).toEqual(["a1", "a3", "a4"]));
    expect(await screen.findByText("Deleted 2 threads. 1 thread kept: the pane is still open.")).toBeInTheDocument();
    fireEvent.change(days, { target: { value: "100" } });
    expect(screen.getByRole("button", { name: "Clear 0" })).toBeDisabled();
  });
});

describe("archived helpers", () => {
  const projects = Object.fromEntries(PROJECTS.map((p) => [p.id, p]));
  it("groupArchived keeps a gone project's threads under its id", () => {
    const groups = groupArchived([archived("x", { projectId: "gone" })], projects);
    expect(groups).toEqual([{ projectId: "gone", label: "gone", threads: [expect.objectContaining({ id: "x" })] }]);
  });
  it("searchArchived matches every word; an empty query is everything", () => {
    expect(searchArchived(THREADS, "  ", projects)).toHaveLength(THREADS.length);
    expect(searchArchived(THREADS, "sightr pi", projects).map((t) => t.id)).toEqual(["a3"]);
  });
  it("archivedOlderThan needs an archivedAt and a sane day count", () => {
    expect(archivedOlderThan([archived("n", { archivedAt: undefined })], 0, NOW)).toEqual([]);
    expect(archivedOlderThan(THREADS, -1, NOW)).toEqual([]);
    expect(archivedOlderThan(THREADS, 50, NOW).map((t) => t.id)).toEqual(["a3", "a4"]);
  });
});
