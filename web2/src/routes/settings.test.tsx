// T31: Settings → Run snapshots. One switch per open project, writing `project.checkpoints.set`; a read-only device sees it
// disabled; a bridge started with SIGHTR_CHECKPOINTS=0 (every run reads `absent: disabled`) shows "Off for this bridge".
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { Run } from "@shared/v2/contracts";
import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { FakeEventSource } from "@/test/fake-event-source";
import { project, shellSnapshot, thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));
type Posted = { commandId: string; type: string; [k: string]: unknown };

let posted: Posted[] = [];
beforeEach(() => {
  posted = [];
  let sequence = 100;
  server.use(
    http.get("/api/notifications/prefs", () => HttpResponse.json({ blocked: true, done: false })),
    http.get("/api/settings", () => HttpResponse.json({ deviceAllowlist: ["phone"], notifyDelayMs: 30_000, submitKeys: ["Enter"], readLines: 200 })),
    http.head("/sw.js", () => new HttpResponse(null)),
    http.post("/api/v2/command", async ({ request }) => {
      posted.push((await request.json()) as Posted);
      return HttpResponse.json({ ok: true, sequence: ++sequence });
    }),
  );
});

async function open(projects = [project("w1", { label: "Sightr" }), project("w2", { label: "Notes", order: 1, checkpoints: false })], device?: { enforced: boolean; device: string | null; authorized: boolean }) {
  setViewportWidth(1280);
  renderApp("/v2/settings");
  await screen.findByRole("heading", { name: "Settings", level: 1 });
  await waitFor(() => expect(shellSource()).toBeDefined());
  frame(() => shellSource()!.emit("snapshot", { ...shellSnapshot(10, [thread("t1")], projects), ...(device ? { device } : {}) }));
  return screen.findByRole("region", { name: "Run snapshots" });
}

describe("/settings: run snapshots", () => {
  it("has a switch per project, on unless the project says off", async () => {
    const section = await open();
    expect(within(section).getByRole("switch", { name: "Take run snapshots in Sightr" })).toBeChecked();
    expect(within(section).getByRole("switch", { name: "Take run snapshots in Notes" })).not.toBeChecked();
    expect(within(section).getAllByText(/nothing is written into your repository/)).toHaveLength(2);
    expect(within(section).getAllByText(/affects later runs only/)).toHaveLength(2);
  });

  it("writes project.checkpoints.set for that project when the switch is flipped", async () => {
    const section = await open();
    fireEvent.click(within(section).getByRole("switch", { name: "Take run snapshots in Sightr" }));
    await waitFor(() => expect(posted).toEqual([expect.objectContaining({ type: "project.checkpoints.set", projectId: "w1", enabled: false })]));
    fireEvent.click(within(section).getByRole("switch", { name: "Take run snapshots in Notes" }));
    await waitFor(() => expect(posted.at(-1)).toMatchObject({ type: "project.checkpoints.set", projectId: "w2", enabled: true }));
  });

  it("redraws from the bridge's project.upserted, not before", async () => {
    const section = await open();
    const notes = within(section).getByRole("switch", { name: "Take run snapshots in Notes" });
    fireEvent.click(notes);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(notes).not.toBeChecked();
    frame(() => shellSource()!.emit("event", { sequence: 11, type: "project.upserted", payload: { project: project("w2", { label: "Notes", order: 1, checkpoints: true }) }, ts: 1 }));
    await waitFor(() => expect(within(section).getByRole("switch", { name: "Take run snapshots in Notes" })).toBeChecked());
  });

  it("read-only: the switches are disabled and write nothing", async () => {
    const section = await open(undefined, { enforced: true, device: "tablet", authorized: false });
    const sw = within(section).getByRole("switch", { name: "Take run snapshots in Sightr" });
    await waitFor(() => expect(sw).toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(sw);
    expect(posted).toEqual([]);
  });

  it("SIGHTR_CHECKPOINTS=0 (every run absent: disabled) shows Off for this bridge, with no switch", async () => {
    const section = await open([project("w1", { label: "Sightr" })]);
    expect(within(section).queryByText("Off for this bridge")).toBeNull();
    const run: Run = {
      id: "r1",
      threadId: "t1",
      ordinal: 1,
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      checkpoint: { runId: "r1", threadId: "t1", appRunOrdinal: 1, status: "absent", reason: "disabled", files: [], additions: 0, deletions: 0 },
    };
    act(() =>
      useThreadStore.setState({
        current: threadFromSnapshot({ sequence: 1, thread: thread("t1"), runs: [run], items: [], requests: [], queue: [], historyCursor: null }, false),
        missing: null,
      }),
    );
    await waitFor(() => expect(within(section).getByText("Off for this bridge")).toBeInTheDocument());
    expect(within(section).queryByRole("switch")).toBeNull();
  });

  it("a project switched off by hand is not read as the bridge being off", async () => {
    const section = await open([project("w1", { label: "Sightr", checkpoints: false })]);
    const run: Run = {
      id: "r1",
      threadId: "t1",
      ordinal: 1,
      status: "completed",
      startedAt: 1,
      checkpoint: { runId: "r1", threadId: "t1", appRunOrdinal: 1, status: "absent", reason: "disabled", files: [], additions: 0, deletions: 0 },
    };
    act(() =>
      useThreadStore.setState({
        current: threadFromSnapshot({ sequence: 1, thread: thread("t1"), runs: [run], items: [], requests: [], queue: [], historyCursor: null }, false),
        missing: null,
      }),
    );
    expect(within(section).getByRole("switch", { name: "Take run snapshots in Sightr" })).not.toBeChecked();
    expect(within(section).queryByText("Off for this bridge")).toBeNull();
  });
});
