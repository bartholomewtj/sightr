import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Thread, ThreadEvent } from "@shared/v2/contracts";
import { applyShellEvent, shellFromSnapshot } from "@/stream/apply";
import { emitShellEvent } from "@/stream/shell-events";
import { useShell } from "@/stream/stores";
import { project, shellSnapshot, thread } from "@/test/fixtures";
import { server } from "@/test/setup";

import {
  __setDraftDeps,
  createDraftProject,
  discardDraft,
  DRAFT_KEY,
  editAndRetry,
  mountDraftScreen,
  noteOpenThread,
  retryWithoutAttachments,
  finishStart,
  openNewProjectForm,
  pickDraftMode,
  selectDraftProject,
  setDraftDirection,
  setDraftEffort,
  setDraftHarness,
  setDraftModel,
  setDraftName,
  setDraftPlacement,
  setDraftText,
  setNewProjectField,
  startDraft,
  addDraftAttachments,
  useDraftThread,
} from "./draft-thread";

let posts: Record<string, unknown>[] = [];
let reply: (body: Record<string, unknown>) => Response | undefined = () => undefined;
let uploads: { paneId: string; name: string }[] = [];
let seq = 10;

beforeEach(() => {
  posts = [];
  uploads = [];
  reply = () => undefined;
  seq = 10;
  let n = 0;
  __setDraftDeps({
    command: () => ({ fetch: (...a) => globalThis.fetch(...a), newId: () => `cmd-${++n}` }),
    upload: async (paneId, file) => {
      uploads.push({ paneId, name: file.name });
      return { ok: true, path: `C:\\up\\${file.name}` } as never;
    },
  });
  server.use(
    http.post("/api/v2/command", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      posts.push(body);
      return reply(body) ?? HttpResponse.json({ ok: true, sequence: ++seq });
    }),
  );
  useShell.setState(shellFromSnapshot(shellSnapshot(5, [thread("t1")], [project("w1"), project("w2", { number: 2, order: 1 })])), true);
});

/** What the shell stream does with one event: apply it, then tell the listeners. */
function shellEvent(event: ThreadEvent): void {
  useShell.setState((s) => applyShellEvent(s, event), true);
  emitShellEvent(event);
}

const created = (sequence: number, commandId: string, t: Thread): ThreadEvent => ({
  sequence,
  commandId,
  threadId: t.id,
  type: "thread.created",
  payload: { thread: t },
  ts: sequence,
});

const statusEvent = (sequence: number, threadId: string, status: Thread["status"]): ThreadEvent => ({
  sequence,
  threadId,
  type: "thread.updated",
  payload: { patch: { status }, at: sequence },
  ts: sequence,
});

const draft = () => useDraftThread.getState().draft;
const start = () => useDraftThread.getState().start;
const flush = () => new Promise((r) => setTimeout(r, 0));

function ready(harness = "claude"): void {
  selectDraftProject("w1");
  setDraftHarness(harness);
}

describe("draft state", () => {
  it("persists across a reload, and Discard clears it", async () => {
    ready();
    setDraftModel("haiku");
    setDraftText("say hi");
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).draft).toMatchObject({ projectId: "w1", harness: "claude", model: "haiku", text: "say hi" });

    vi.resetModules();
    const fresh = await import("./draft-thread");
    expect(fresh.useDraftThread.getState().draft).toMatchObject({ projectId: "w1", harness: "claude", model: "haiku", text: "say hi" });

    discardDraft();
    expect(draft()).toMatchObject({ projectId: null, harness: null, text: "" });
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("switching harness clears model, effort and mode", () => {
    ready();
    setDraftModel("haiku");
    setDraftEffort("high");
    pickDraftMode("plan");
    setDraftHarness("pi");
    expect(draft()).toMatchObject({ harness: "pi", model: "", effort: "", permissionMode: "" });
  });

  it("a destructive mode needs a second tap", () => {
    ready();
    expect(pickDraftMode("bypassPermissions")).toBe("armed");
    expect(draft().permissionMode).toBe("");
    expect(useDraftThread.getState().bypassArmed).toBe("bypassPermissions");
    expect(pickDraftMode("bypassPermissions")).toBe("selected");
    expect(draft().permissionMode).toBe("bypassPermissions");
    // A plain mode is one tap.
    expect(pickDraftMode("plan")).toBe("selected");
  });

  it("the tab name follows the first message until the operator types one", () => {
    ready();
    setDraftText("fix the login bug please now");
    expect(draft().name).toBe("fix the login bug please");
    setDraftName("Login");
    setDraftText("something else");
    expect(draft().name).toBe("Login");
  });

  it("a project brings back the harness and mode last used in it (never a bypass mode)", async () => {
    ready();
    pickDraftMode("plan");
    await startDraft();
    discardDraft();
    selectDraftProject("w2");
    expect(draft()).toMatchObject({ projectId: "w2", harness: null });
    selectDraftProject("w1");
    expect(draft()).toMatchObject({ projectId: "w1", harness: "claude", permissionMode: "plan" });

    discardDraft();
    ready("grok");
    pickDraftMode("bypassPermissions");
    pickDraftMode("bypassPermissions");
    await startDraft();
    await startDraft();
    discardDraft();
    selectDraftProject("w1");
    expect(draft()).toMatchObject({ harness: "grok", permissionMode: "" });
  });
});

describe("start", () => {
  it("posts one thread.create of ids, with no message in it; a double tap posts nothing more", async () => {
    ready();
    setDraftModel("haiku");
    setDraftText("say hi");
    const [a, b] = await Promise.all([startDraft(), startDraft()]);
    expect([a, b].sort()).toEqual(["busy", "started"]);
    const creates = posts.filter((p) => p.type === "thread.create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toEqual({
      commandId: "cmd-1",
      type: "thread.create",
      projectId: "w1",
      harness: "claude",
      model: "haiku",
      name: "say hi",
      placement: "tab",
    });
    expect(start()).toMatchObject({ phase: "creating", commandId: "cmd-1", firstMessage: "say hi", commandLine: "claude --model haiku" });
  });

  it("a network retry reuses the commandId", async () => {
    let calls = 0;
    __setDraftDeps({
      command: () => ({
        newId: () => "same",
        fetch: async (...args) => {
          calls++;
          if (calls === 1) throw new TypeError("Failed to fetch");
          return globalThis.fetch(...args);
        },
      }),
    });
    ready();
    await startDraft();
    expect(posts.map((p) => p.commandId)).toEqual(["same"]);
  });

  it("a destructive mode asks once more at Start, then sends confirmBypass", async () => {
    ready();
    pickDraftMode("bypassPermissions");
    pickDraftMode("bypassPermissions");
    expect(await startDraft()).toBe("confirm");
    expect(posts).toHaveLength(0);
    expect(await startDraft()).toBe("started");
    expect(posts[0]).toMatchObject({ permissionMode: "bypassPermissions", confirmBypass: true });
  });

  it("split: next to the open thread, in its project", async () => {
    noteOpenThread("t1");
    ready();
    setDraftPlacement("split");
    setDraftDirection("down");
    await startDraft();
    expect(posts[0]).toMatchObject({ placement: "split", splitFrom: "t1", direction: "down" });
  });

  it("after thread.created: attachments upload to its pane, then one message.dispatch in queue mode", async () => {
    ready();
    setDraftText("say hi");
    addDraftAttachments([new File(["x"], "shot.png")]);
    await startDraft();
    shellEvent(created(20, "cmd-1", thread("n1", { paneId: "w1:p9", status: "starting" })));
    await vi.waitFor(() => expect(start()?.messageState).toBe("sent"));
    expect(start()).toMatchObject({ threadId: "n1", phase: "starting" });
    expect(uploads).toEqual([{ paneId: "w1:p9", name: "shot.png" }]);
    const dispatches = posts.filter((p) => p.type === "message.dispatch");
    expect(dispatches).toEqual([
      {
        commandId: "cmd-2",
        type: "message.dispatch",
        threadId: "n1",
        text: "say hi",
        mode: "queue",
        attachments: [{ path: "C:\\up\\shot.png", name: "shot.png" }],
      },
    ]);
  });

  it("a refused attachment: retry without it sends the message, and a failed start can be left", async () => {
    let refuse = true;
    __setDraftDeps({
      upload: async () => (refuse ? ({ ok: false, error: "unsupported file type" } as never) : ({ ok: true, path: "up-x" } as never)),
    });
    const unmount = mountDraftScreen();
    ready();
    setDraftText("read this");
    addDraftAttachments([new File(["x"], "paper.pdf")]);
    await startDraft();
    shellEvent(created(20, "cmd-1", thread("n1", { paneId: "w1:p9", status: "starting" })));
    await vi.waitFor(() => expect(start()?.messageState).toBe("failed"));
    expect(start()?.messageError).toContain("paper.pdf");
    refuse = false;
    retryWithoutAttachments();
    expect(useDraftThread.getState().attachments).toEqual([]);
    await vi.waitFor(() => expect(start()?.messageState).toBe("sent"));
    unmount();
  });

  it("finishStart leaves a failed first message behind so the next draft is not blocked", async () => {
    __setDraftDeps({ upload: async () => ({ ok: false, error: "unsupported file type" }) as never });
    const unmount = mountDraftScreen();
    ready();
    setDraftText("read this");
    addDraftAttachments([new File(["x"], "paper.pdf")]);
    await startDraft();
    shellEvent(created(20, "cmd-1", thread("n1", { paneId: "w1:p9", status: "starting" })));
    await vi.waitFor(() => expect(start()?.messageState).toBe("failed"));
    finishStart();
    expect(start()).toBeNull();
    unmount();
  });

  it("a send that was in flight when the page reloaded comes back failed, not spinning", async () => {
    vi.resetModules();
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        draft: {},
        start: { commandId: "c", threadId: "n1", phase: "ready", startedAt: 1, harnessLabel: "pi", commandLine: null, firstMessage: "hi", messageState: "pending", messageError: null, failure: null },
      }),
    );
    const fresh = await import("./draft-thread");
    expect(fresh.useDraftThread.getState().start).toMatchObject({ messageState: "failed" });
    fresh.__resetDraftThread();
  });

  it("creating → starting → ready; with no screen open the draft then clears by itself", async () => {
    ready();
    await startDraft();
    expect(start()?.phase).toBe("creating");
    shellEvent(created(20, "cmd-1", thread("n1", { status: "starting" })));
    expect(start()).toMatchObject({ phase: "starting", threadId: "n1" });
    shellEvent(statusEvent(21, "n1", "idle"));
    // No draft screen is mounted: the start is done and the thread is simply in the sidebar.
    expect(start()).toBeNull();
    expect(draft().harness).toBeNull();
  });

  it("with the screen open, Ready waits for the screen to move on", async () => {
    const unmount = mountDraftScreen();
    ready();
    await startDraft();
    shellEvent(created(20, "cmd-1", thread("n1", { status: "starting" })));
    shellEvent(statusEvent(21, "n1", "idle"));
    expect(start()?.phase).toBe("ready");
    unmount();
    expect(start()).toBeNull();
  });

  it("thread.create.failed fails the start and keeps the draft and the message", async () => {
    const unmount = mountDraftScreen();
    ready();
    setDraftText("say hi");
    await startDraft();
    shellEvent(created(20, "cmd-1", thread("n1", { status: "starting" })));
    await flush();
    shellEvent({
      sequence: 21,
      commandId: "cmd-1",
      threadId: "n1",
      type: "thread.create.failed",
      payload: { threadId: "n1", stage: "agent", message: "herdr cannot start this harness" },
      ts: 21,
    });
    // The thread's later status does not undo the failure.
    shellEvent(statusEvent(22, "n1", "idle"));
    expect(start()).toMatchObject({ phase: "failed", failure: { message: "herdr cannot start this harness", stage: "agent" } });
    editAndRetry();
    expect(start()).toBeNull();
    expect(draft()).toMatchObject({ harness: "claude", text: "say hi" });
    unmount();
  });

  it("a refused command fails with the bridge's reason and keeps the draft", async () => {
    reply = () => HttpResponse.json({ ok: false, code: "not_found", error: "no-such-project" }, { status: 404 });
    ready();
    await startDraft();
    expect(start()).toMatchObject({ phase: "failed", failure: { message: "That project is gone." } });
    expect(draft().projectId).toBe("w1");
  });

  it("a reload during a start is rebuilt from the thread's status", async () => {
    ready();
    await startDraft();
    shellEvent(created(20, "cmd-1", thread("n1", { status: "starting" })));
    const saved = localStorage.getItem(DRAFT_KEY)!;
    expect(JSON.parse(saved).start).toMatchObject({ threadId: "n1", phase: "starting" });

    vi.resetModules();
    const fresh = await import("./draft-thread");
    const stores = await import("@/stream/stores");
    const unmount = fresh.mountDraftScreen();
    expect(fresh.useDraftThread.getState().start).toMatchObject({ phase: "starting", threadId: "n1" });
    stores.useShell.setState(shellFromSnapshot(shellSnapshot(30, [thread("n1", { status: "idle" })])), true);
    expect(fresh.useDraftThread.getState().start?.phase).toBe("ready");
    unmount();
  });
});

describe("new project", () => {
  it("posts project.create and selects the project from the project.upserted with the same commandId", async () => {
    openNewProjectForm();
    setNewProjectField("label", "v2-test");
    setNewProjectField("cwd", "C:\\scratch");
    const pending = createDraftProject();
    expect(useDraftThread.getState().form.commandId).toBe("cmd-1");
    shellEvent({ sequence: 20, commandId: "cmd-1", type: "project.upserted", payload: { project: project("w9", { label: "v2-test" }) }, ts: 20 });
    await pending;
    expect(posts[0]).toEqual({ commandId: "cmd-1", type: "project.create", cwd: "C:\\scratch", label: "v2-test" });
    expect(draft().projectId).toBe("w9");
    expect(useDraftThread.getState().form.open).toBe(false);
  });

  it("a refusal keeps the form open with the reason", async () => {
    reply = () => HttpResponse.json({ ok: false, code: "invalid", error: "bad-cwd" }, { status: 400 });
    openNewProjectForm();
    setNewProjectField("cwd", "C:\\nope");
    await createDraftProject();
    expect(useDraftThread.getState().form).toMatchObject({ open: true, commandId: null, error: "That folder does not exist on the host." });
  });
});
