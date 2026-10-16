import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project, Thread, ThreadEvent } from "@shared/v2/contracts";
import { noteOpenThread, useDraftThread } from "@/state/draft-thread";
import { FakeEventSource } from "@/test/fake-event-source";
import { project, shellSnapshot, thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));

type Posted = { commandId: string; type: string; [k: string]: unknown };

function commands(answer?: (body: Posted) => Response | undefined): Posted[] {
  const bodies: Posted[] = [];
  let sequence = 100;
  server.use(
    http.post("/api/v2/command", async ({ request }) => {
      const body = (await request.json()) as Posted;
      bodies.push(body);
      return answer?.(body) ?? HttpResponse.json({ ok: true, sequence: ++sequence });
    }),
  );
  return bodies;
}

async function openNew(
  path = "/v2/new",
  threads: Thread[] = [thread("t1")],
  projects: Project[] = [project("w1", { label: "Sightr" }), project("w2", { label: "Other", number: 2, order: 1 })],
  width = 1280,
) {
  setViewportWidth(width);
  const utils = renderApp(path);
  await waitFor(() => expect(shellSource()).toBeDefined());
  frame(() => shellSource()!.emit("snapshot", shellSnapshot(10, threads, projects)));
  if (path.startsWith("/v2/new")) await screen.findByRole("region", { name: "New thread" });
  else await screen.findByRole("navigation", { name: "Threads" });
  return utils;
}

const emit = (event: ThreadEvent) => frame(() => shellSource()!.emit("event", event));
const radio = (group: string, name: string | RegExp) => within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });

async function pickProject(label: string) {
  fireEvent.click(document.querySelector<HTMLElement>("[data-draft-project-trigger]")!);
  fireEvent.click(within(await screen.findByRole("listbox", { name: "Projects" })).getByRole("button", { name: new RegExp(`^${label}`) }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("entry points", () => {
  it("the sidebar header and each project row open the draft", async () => {
    await openNew("/v2/");
    expect(screen.getByRole("link", { name: "New thread" })).toHaveAttribute("href", "/v2/new");
    expect(screen.getByRole("link", { name: "New thread in Sightr" })).toHaveAttribute("href", "/v2/new?project=w1");
  });

  it("?project= preselects the project", async () => {
    await openNew("/v2/new?project=w2");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("What should we build in Other?");
  });

  it("an empty shell opens on the New project form", async () => {
    await openNew("/v2/new", [], []);
    expect(screen.getByRole("form", { name: "New project" })).toBeInTheDocument();
  });
});

describe("project picker", () => {
  it("lists projects with search, and New project posts project.create and selects the new project", async () => {
    const posts = commands();
    await openNew();
    fireEvent.click(screen.getByRole("button", { name: "Choose a project" }));
    const list = await screen.findByRole("listbox", { name: "Projects" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Sightr11 thread", "Other20 threads", "New project…"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search projects" }), { target: { value: "oth" } });
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    fireEvent.click(within(list).getByRole("button", { name: "New project…" }));
    const form = screen.getByRole("form", { name: "New project" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Name" }), { target: { value: "v2-test" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Folder on the host" }), { target: { value: "C:\\scratch" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ type: "project.create", cwd: "C:\\scratch", label: "v2-test" });
    expect(within(form).getByRole("button", { name: "Creating…" })).toBeDisabled();
    emit({ sequence: 20, commandId: posts[0]!.commandId, type: "project.upserted", payload: { project: project("w9", { label: "v2-test" }) }, ts: 20 });
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("What should we build in v2-test?"));
    expect(screen.queryByRole("form", { name: "New project" })).toBeNull();
  });
});

describe("harness and pickers", () => {
  it("tiles are a radio group: arrows move and select, nothing is preselected, Start waits for a choice", async () => {
    await openNew("/v2/new?project=w1");
    const group = screen.getByRole("radiogroup", { name: "Start" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.at(-1)).toHaveAccessibleName("Terminal only");
    expect(radios.every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: " " });
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(radios[1]);
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("pickers follow the harness: labelled groups, 'Fixed at start', hidden when empty", async () => {
    await openNew("/v2/new?project=w1");
    fireEvent.click(radio("Start", "Claude Code"));
    expect(screen.getByRole("radiogroup", { name: "Model" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Effort" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Permission mode" })).toBeInTheDocument();
    expect(screen.getByText("Model").nextSibling).toHaveTextContent("Fixed at start");
    expect(screen.getByText("Permission mode").nextSibling).toHaveTextContent("Can change after start");
    fireEvent.click(radio("Model", "Haiku"));
    fireEvent.click(radio("Start", "pi"));
    expect(screen.queryByRole("radiogroup", { name: "Permission mode" })).toBeNull();
    expect(radio("Model", "Default")).toHaveAttribute("aria-checked", "true");
  });

  it("Terminal only hides the pickers and the first message", async () => {
    await openNew("/v2/new?project=w1");
    fireEvent.click(radio("Start", "Terminal only"));
    expect(screen.queryByRole("radiogroup", { name: "Model" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "First message (optional)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("the Command line equals the launch table's arguments", async () => {
    await openNew("/v2/new?project=w1");
    fireEvent.click(radio("Start", "Claude Code"));
    fireEvent.click(radio("Model", "Haiku"));
    fireEvent.click(radio("Permission mode", "Plan"));
    fireEvent.click(screen.getByRole("button", { name: "Command" }));
    expect(screen.getByTestId("draft-command")).toHaveTextContent("claude --model haiku --permission-mode plan");
    fireEvent.change(screen.getByRole("textbox", { name: "Other model id" }), { target: { value: "claude-opus-5-5" } });
    expect(screen.getByTestId("draft-command")).toHaveTextContent("claude --model claude-opus-5-5 --permission-mode plan");
  });

  it("bypass: a warning on the first tap, selected on the second, Start asks again, then confirmBypass", async () => {
    const posts = commands();
    await openNew("/v2/new?project=w1");
    fireEvent.click(radio("Start", "Claude Code"));
    fireEvent.click(radio("Permission mode", "Bypass permissions"));
    expect(screen.getByRole("alert")).toHaveTextContent("Tap it again to use it");
    expect(radio("Permission mode", "Bypass permissions")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(radio("Permission mode", "Bypass permissions"));
    expect(radio("Permission mode", "Bypass permissions")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(posts).toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: "Start with approvals off" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ type: "thread.create", permissionMode: "bypassPermissions", confirmBypass: true });
  });
});

describe("placement", () => {
  it("split is off with no open thread, and on for an open thread in the project", async () => {
    await openNew("/v2/new?project=w1");
    fireEvent.click(radio("Start", "pi"));
    expect(radio("Placement", "Split current pane")).toBeDisabled();
    act(() => noteOpenThread("t1"));
    expect(radio("Placement", "Split current pane")).toBeEnabled();
    fireEvent.click(radio("Placement", "Split current pane"));
    expect(screen.getByRole("radiogroup", { name: "Split direction" })).toBeInTheDocument();
    // Another project's thread cannot be split from.
    await pickProject("Other");
    expect(radio("Placement", "Split current pane")).toBeDisabled();
  });
});

describe("start and progress", () => {
  it("Start and send: creating → starting → ready opens the thread, and the message is queued", async () => {
    const posts = commands();
    const { router } = await openNew("/v2/new?project=w1");
    fireEvent.click(radio("Start", "Claude Code"));
    fireEvent.change(screen.getByRole("textbox", { name: "First message (optional)" }), { target: { value: "say hi" } });
    expect(screen.getByRole("textbox", { name: "Tab name" })).toHaveValue("say hi");
    fireEvent.click(screen.getByRole("button", { name: "Start and send" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty("text");
    const progress = screen.getByRole("region", { name: "Starting the thread" });
    expect(within(progress).getAllByRole("list")[0]).toHaveAttribute("aria-live", "polite");
    expect(within(progress).getByText("Creating pane").previousSibling).toHaveAccessibleName("In progress");

    emit({ sequence: 20, commandId: posts[0]!.commandId, threadId: "n1", type: "thread.created", payload: { thread: thread("n1", { status: "starting" }) }, ts: 20 });
    await waitFor(() => expect(posts.map((p) => p.type)).toEqual(["thread.create", "message.dispatch"]));
    expect(posts[1]).toMatchObject({ threadId: "n1", text: "say hi", mode: "queue" });
    expect(within(progress).getByText("Starting Claude Code").previousSibling).toHaveAccessibleName("In progress");

    emit({ sequence: 21, threadId: "n1", type: "thread.updated", payload: { patch: { status: "idle" }, at: 21 }, ts: 21 });
    await waitFor(() => expect(router.state.location.pathname).toBe("/thread/n1"));
    expect(useDraftThread.getState().start).toBeNull();
  });

  it("a slow start shows Still starting… and Open terminal after 45 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const posts = commands();
    await openNew("/v2/new?project=w1");
    fireEvent.click(radio("Start", "Codex CLI"));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    emit({ sequence: 20, commandId: posts[0]!.commandId, threadId: "n1", type: "thread.created", payload: { thread: thread("n1", { status: "starting" }) }, ts: 20 });
    expect(screen.queryByText("Still starting…")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(46_000);
    });
    expect(screen.getByText("Still starting…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open terminal" })).toBeInTheDocument();
  });

  it("a failed start shows the reason and the command, and Edit and try again keeps the draft", async () => {
    const posts = commands();
    await openNew("/v2/new?project=w1");
    fireEvent.click(radio("Start", "Claude Code"));
    fireEvent.click(radio("Model", "Haiku"));
    fireEvent.change(screen.getByRole("textbox", { name: "First message (optional)" }), { target: { value: "say hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Start and send" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    emit({ sequence: 20, commandId: posts[0]!.commandId, threadId: "n1", type: "thread.created", payload: { thread: thread("n1", { status: "starting" }) }, ts: 20 });
    emit({
      sequence: 21,
      commandId: posts[0]!.commandId,
      threadId: "n1",
      type: "thread.create.failed",
      payload: { threadId: "n1", stage: "agent", message: "herdr cannot start this harness" },
      ts: 21,
    });
    const alert = await screen.findByText("herdr cannot start this harness");
    expect(alert.closest("[role=alert]")).toHaveTextContent("Tried: claude --model haiku");
    expect(screen.getByRole("button", { name: "Open as terminal" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit and try again" }));
    expect(screen.getByRole("textbox", { name: "First message (optional)" })).toHaveValue("say hi");
    expect(radio("Model", "Haiku")).toHaveAttribute("aria-checked", "true");
  });

  it("closing the screen during a start leaves the thread to the sidebar", async () => {
    const posts = commands();
    const { router } = await openNew("/v2/new?project=w1");
    fireEvent.click(radio("Start", "pi"));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await act(() => router.navigate({ to: "/" }));
    emit({ sequence: 20, commandId: posts[0]!.commandId, threadId: "n1", type: "thread.created", payload: { thread: thread("n1", { status: "starting", title: "pi-1" }) }, ts: 20 });
    expect(await screen.findByRole("link", { name: /^pi-1,/ })).toBeInTheDocument();
    emit({ sequence: 21, threadId: "n1", type: "thread.updated", payload: { patch: { status: "idle" }, at: 21 }, ts: 21 });
    await waitFor(() => expect(useDraftThread.getState().start).toBeNull());
    expect(router.state.location.pathname).toBe("/");
  });
});
