import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { NO_CAPABILITIES, type QueuedMessage, type Run, type RuntimeRequest, type Thread, type TurnItem } from "@shared/v2/contracts";
import { undoLatestThreadAction, useThreadUndoNotice } from "@/hooks/showThreadUndoNotice";
import { loadDraft, saveDraft } from "@/lib/drafts";
import { __setComposerDeps, setFollowUp } from "@/state/composer";
import { applyThreadEvent, threadFromSnapshot } from "@/stream/apply";
import { useBridgeInfo, useStreamHealth, useThreadStore } from "@/stream/stores";
import { thread as threadFixture } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

import { ShortcutListener } from "@/components/GlobalShortcuts";
import { useRightPanelStore } from "@/rightPanelStore";

import { ChatComposer } from "./ChatComposer";

const ALL = { ...NO_CAPABILITIES, hasJournal: true, canInterrupt: true, canQueueDrain: true, interruptKeys: ["Escape"] };

interface Setup {
  thread?: Partial<Thread>;
  queue?: QueuedMessage[];
  requests?: RuntimeRequest[];
  runs?: Run[];
  items?: TurnItem[];
}

let posts: Record<string, unknown>[] = [];
let reply: (body: Record<string, unknown>) => Response | undefined = () => undefined;
let seq = 100;

beforeEach(() => {
  posts = [];
  reply = () => undefined;
  seq = 100;
  setViewportWidth(800);
  let n = 0;
  __setComposerDeps({ command: () => ({ fetch: (...a) => globalThis.fetch(...a), newId: () => `cmd-${++n}` }) });
  server.use(
    http.post("/api/v2/command", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      posts.push(body);
      return reply(body) ?? HttpResponse.json({ ok: true, sequence: ++seq });
    }),
  );
  useStreamHealth.setState({ status: "live" });
});

function setThread(opts: Setup = {}, sequence = 1): void {
  useThreadStore.setState({
    current: threadFromSnapshot(
      {
        sequence,
        thread: threadFixture("t1", { capabilities: ALL, ...opts.thread }),
        runs: opts.runs ?? [],
        items: opts.items ?? [],
        requests: opts.requests ?? [],
        queue: opts.queue ?? [],
        historyCursor: null,
      },
      false,
    ),
    missing: null,
  });
}

function patchThread(fn: (s: NonNullable<ReturnType<typeof useThreadStore.getState>["current"]>) => Partial<NonNullable<ReturnType<typeof useThreadStore.getState>["current"]>>): void {
  act(() => {
    const current = useThreadStore.getState().current!;
    useThreadStore.setState({ current: { ...current, ...fn(current) } });
  });
}

function show(opts: Setup = {}) {
  setThread(opts);
  // T13: the keybinding table's listener, which runs the composer's table commands.
  return render(
    <>
      <ShortcutListener />
      <ChatComposer threadId="t1" />
    </>,
  );
}

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const primary = () => document.querySelector<HTMLButtonElement>("[data-primary-kind]");
const commands = (type: string) => posts.filter((p) => p.type === type);

function row(id: string, over: Partial<QueuedMessage> = {}): QueuedMessage {
  return { id, threadId: "t1", text: `queued ${id}`, attachments: [], position: 0, mode: "queue", state: "queued", createdAt: 1, ...over };
}

function request(over: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return {
    id: "r1",
    threadId: "t1",
    kind: "permission",
    prompt: "Run `rm build`?",
    options: [
      { label: "Yes", keys: ["1"] },
      { label: "No", keys: ["3"], destructive: true },
    ],
    status: "pending",
    bindingHash: "h",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

// ── Button matrix ───────────────────────────────────────────────────────────────────────────────

describe("ChatComposer: the primary button", () => {
  it("idle: disabled Send until there is text, then Send posts message.dispatch {mode: start}", async () => {
    show();
    expect(primary()).toHaveAccessibleName("Send");
    expect(primary()).toBeDisabled();
    type("hello");
    expect(primary()).toBeEnabled();
    fireEvent.click(primary()!);
    await waitFor(() => expect(commands("message.dispatch")).toHaveLength(1));
    expect(commands("message.dispatch")[0]).toMatchObject({ threadId: "t1", text: "hello", mode: "start" });
    await waitFor(() => expect(box().value).toBe(""));
  });

  it("working and empty: Stop posts run.interrupt", async () => {
    show({ thread: { status: "working" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(commands("run.interrupt")).toEqual([expect.objectContaining({ threadId: "t1" })]));
  });

  it("working with text: Queue by default with Stop beside it; Steer when the setting says so", async () => {
    show({ thread: { status: "working" } });
    type("next");
    expect(primary()).toHaveAccessibleName("Queue");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    fireEvent.click(primary()!);
    await waitFor(() => expect(commands("message.dispatch")[0]).toMatchObject({ mode: "queue" }));
    await waitFor(() => expect(box().value).toBe(""));
    act(() => setFollowUp("steer"));
    type("now");
    expect(primary()).toHaveAccessibleName("Steer");
    expect(localStorage.getItem("sightr:v2:composer:follow-up")).toBe("steer");
  });

  it("while a /compact run works, a follow-up queues even with Steer set or Ctrl held, and says why (T3 #20184)", async () => {
    act(() => setFollowUp("steer"));
    const compact: TurnItem = {
      id: "u1",
      threadId: "t1",
      runId: "run1",
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      createdAt: 1,
      updatedAt: 1,
      type: "user_message",
      messageId: "u1",
      text: "/compact",
      attachments: [],
    };
    show({
      thread: { status: "working" },
      runs: [{ id: "run1", threadId: "t1", ordinal: 1, userItemId: "u1", status: "running", startedAt: 1 }],
      items: [compact],
    });
    type("after the compaction");
    expect(primary()).toHaveAccessibleName("Queue");
    expect(screen.getByText(/Compacting/)).toBeInTheDocument();
    fireEvent.click(primary()!, { ctrlKey: true });
    await waitFor(() => expect(commands("message.dispatch")[0]).toMatchObject({ mode: "queue" }));
  });

  it("Ctrl-click and mod+Enter do the other follow-up", async () => {
    show({ thread: { status: "working" } });
    type("a");
    fireEvent.click(primary()!, { ctrlKey: true });
    await waitFor(() => expect(commands("message.dispatch")[0]).toMatchObject({ mode: "steer" }));
    await waitFor(() => expect(box().value).toBe(""));
    setViewportWidth(1200); // desktop: Enter sends, mod+Enter flips
    type("b");
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(commands("message.dispatch")[1]).toMatchObject({ mode: "steer", text: "b" }));
  });

  it("hides Steer without canInterrupt, and Queue without canQueueDrain", () => {
    localStorage.setItem("sightr:v2:composer:follow-up", "steer");
    const { unmount } = show({ thread: { status: "working", capabilities: { ...NO_CAPABILITIES, canQueueDrain: true } } });
    type("x");
    expect(primary()).toHaveAccessibleName("Queue");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    unmount();
    show({ thread: { status: "working", harness: "shell", capabilities: { ...NO_CAPABILITIES, canInterrupt: true, interruptKeys: ["ctrl+c"] } } });
    type("x");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(primary()).toBeNull();
  });

  it("a tap cannot post twice while the reply is pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post("/api/v2/command", async ({ request }) => {
        posts.push((await request.json()) as Record<string, unknown>);
        await gate;
        return HttpResponse.json({ ok: true, sequence: 5 });
      }),
    );
    show();
    type("once");
    fireEvent.click(primary()!);
    await waitFor(() => expect(primary()).toBeDisabled());
    fireEvent.click(primary()!);
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    release();
    await waitFor(() => expect(box().value).toBe(""));
    expect(commands("message.dispatch")).toHaveLength(1);
  });
});

// ── Enter setting ───────────────────────────────────────────────────────────────────────────────

describe("ChatComposer: Enter", () => {
  it("on a phone Enter adds a line by default; Mod+Enter sends", async () => {
    show();
    type("hi");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(posts).toHaveLength(0);
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(commands("message.dispatch")).toHaveLength(1));
  });

  it("on desktop Enter sends and Shift+Enter does not; IME composition never sends", async () => {
    setViewportWidth(1200);
    show();
    type("hi");
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
    expect(posts).toHaveLength(0);
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(commands("message.dispatch")).toHaveLength(1));
  });

  it("the stored setting wins over the device default", async () => {
    localStorage.setItem("sightr:v2:composer:enter", "enter");
    const { __resetComposerState } = await import("@/state/composer");
    __resetComposerState();
    __setComposerDeps({ command: () => ({ fetch: (...a) => globalThis.fetch(...a), newId: () => "cmd-x" }) });
    show();
    type("hi");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(commands("message.dispatch")).toHaveLength(1));
  });
});

// ── Draft ───────────────────────────────────────────────────────────────────────────────────────

describe("ChatComposer: draft", () => {
  it("is saved per thread and restored on mount", () => {
    saveDraft("t1", "from before");
    show();
    expect(box().value).toBe("from before");
    type("changed");
    expect(loadDraft("t1")).toBe("changed");
    expect(loadDraft("t2")).toBeNull();
  });

  it("clears only on the bridge's reply; a 500 keeps it and offers Retry", async () => {
    reply = () => HttpResponse.json({ ok: false, code: "failed", error: "boom" }, { status: 500 });
    show();
    type("keep me");
    fireEvent.click(primary()!);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("boom"));
    expect(box().value).toBe("keep me");
    expect(loadDraft("t1")).toBe("keep me");
    reply = () => undefined;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(loadDraft("t1")).toBeNull());
    expect(commands("message.dispatch").map((p) => p.text)).toEqual(["keep me", "keep me"]);
  });

  it("a large paste asks to attach it as a file instead", () => {
    show();
    const big = "x".repeat(40 * 1024);
    fireEvent.paste(box(), { clipboardData: { getData: () => big, files: [] } });
    expect(screen.getByRole("alertdialog", { name: "Large paste" })).toHaveTextContent("Attach as a file instead?");
    expect(box().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Paste anyway" }));
    expect(box().value).toHaveLength(big.length);
  });
});

describe("ChatComposer: destructive text", () => {
  it("needs a second tap", async () => {
    show();
    type("rm -rf ./build");
    fireEvent.click(primary()!);
    expect(posts).toHaveLength(0);
    expect(primary()).toHaveAccessibleName("Confirm");
    expect(screen.getByText(/Destructive: rm -r/)).toBeInTheDocument();
    fireEvent.click(primary()!);
    await waitFor(() => expect(commands("message.dispatch")).toHaveLength(1));
  });
});

// ── Queue ───────────────────────────────────────────────────────────────────────────────────────

describe("ChatComposer: the queued list", () => {
  it("lists the bridge's queue and reorders with the grip's arrow keys (queued.reorder)", async () => {
    show({ thread: { status: "working" }, queue: [row("q1"), row("q2", { position: 1 })] });
    const region = screen.getByRole("region", { name: "2 queued messages" });
    expect(within(region).getByText("Queued (2)")).toBeInTheDocument();
    const grips = within(region).getAllByRole("button", { name: /Reorder queued message/ });
    fireEvent.keyDown(grips[0]!, { key: "ArrowDown" });
    await waitFor(() => expect(commands("queued.reorder")).toEqual([expect.objectContaining({ threadId: "t1", ids: ["q2", "q1"] })]));
  });

  it("edits a queued message in the box (queued.edit), then gives the box its draft back", async () => {
    show({ thread: { status: "working" }, queue: [row("q1")] });
    type("my draft");
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    expect(box().value).toBe("queued q1");
    expect(screen.getByText("Editing queued message")).toBeInTheDocument();
    type("queued q1, edited");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(commands("queued.edit")).toEqual([expect.objectContaining({ id: "q1", text: "queued q1, edited" })]));
    await waitFor(() => expect(box().value).toBe("my draft"));
    expect(loadDraft("t1")).toBe("my draft");
  });

  it("Escape discards an edit", () => {
    show({ thread: { status: "working" }, queue: [row("q1")] });
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(box().value).toBe("");
    expect(screen.queryByText("Editing queued message")).toBeNull();
  });

  it("cancel offers Undo, which re-queues the message at the same position", async () => {
    show({ thread: { status: "working" }, queue: [row("q1"), row("q2", { position: 1 })] });
    fireEvent.click(screen.getAllByRole("button", { name: "Remove queued message" })[0]!);
    await waitFor(() => expect(commands("queued.cancel")).toEqual([expect.objectContaining({ id: "q1" })]));
    await waitFor(() => expect(useThreadUndoNotice.getState().notice?.action).toBe("Removed from queue"));
    patchThread(() => ({ queue: [row("q2")] }));
    act(() => {
      undoLatestThreadAction();
    });
    await waitFor(() => expect(commands("message.dispatch")).toEqual([expect.objectContaining({ text: "queued q1", mode: "queue" })]));
    patchThread(() => ({ queue: [row("q2"), row("q3", { text: "queued q1", position: 1 })] }));
    await waitFor(() => expect(commands("queued.reorder")).toEqual([expect.objectContaining({ ids: ["q3", "q2"] })]));
  });

  it("after a restart: Paused after restart, one Resume (queue.resume)", async () => {
    show({ queue: [row("q1", { state: "held", heldReason: "restart" }), row("q2", { state: "held", heldReason: "restart" })] });
    expect(screen.getByText("Paused after restart")).toBeInTheDocument();
    const resume = screen.getAllByRole("button", { name: "Resume" });
    expect(resume).toHaveLength(1);
    fireEvent.click(resume[0]!);
    await waitFor(() => expect(commands("queue.resume")).toEqual([expect.objectContaining({ threadId: "t1" })]));
  });

  it("a message the bridge dropped says so", () => {
    show({ queue: [row("q1", { state: "held", heldReason: "pane-closed" })] });
    expect(screen.getByText("Not sent: pane closed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("Steer now sends the row as a steer, then cancels it", async () => {
    show({ thread: { status: "working" }, queue: [row("q1")] });
    fireEvent.click(screen.getByRole("button", { name: "Steer now" }));
    await waitFor(() => expect(commands("queued.cancel")).toHaveLength(1));
    expect(commands("message.dispatch")[0]).toMatchObject({ text: "queued q1", mode: "steer" });
  });
});

// ── Attachments ─────────────────────────────────────────────────────────────────────────────────

describe("ChatComposer: attachments", () => {
  it("uploads on add, Send waits for it, and the payload carries {path, name}", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post("/api/pane/:paneId/upload", async ({ params }) => {
        await gate;
        return HttpResponse.json({ ok: true, path: `C:/up/${String(params.paneId)}/shot.png` });
      }),
    );
    show();
    const file = new File(["png"], "shot.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("attach-input"), { target: { files: [file] } });
    const chip = () => screen.getByRole("list", { name: "Attachments" }).querySelector("li")!;
    expect(chip()).toHaveAttribute("data-attachment-status", "uploading");
    type("look");
    expect(primary()).toBeDisabled();
    release();
    await waitFor(() => expect(chip()).toHaveAttribute("data-attachment-status", "done"));
    fireEvent.click(primary()!);
    await waitFor(() => expect(commands("message.dispatch")).toHaveLength(1));
    expect(commands("message.dispatch")[0]).toMatchObject({ text: "look", attachments: [{ path: "C:/up/p-t1/shot.png", name: "shot.png" }] });
    await waitFor(() => expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull());
  });

  it("a failed upload shows Retry and Remove", async () => {
    let fail = true;
    server.use(
      http.post("/api/pane/:paneId/upload", () =>
        fail ? HttpResponse.json({ ok: false, error: "too big" }, { status: 413 }) : HttpResponse.json({ ok: true, path: "C:/up/a.txt" }),
      ),
    );
    show();
    fireEvent.change(screen.getByTestId("attach-input"), { target: { files: [new File(["a"], "a.txt", { type: "text/plain" })] } });
    const chip = () => screen.getByRole("list", { name: "Attachments" }).querySelector("li")!;
    await waitFor(() => expect(chip()).toHaveAttribute("data-attachment-status", "failed"));
    fail = false;
    fireEvent.click(within(chip()).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(chip()).toHaveAttribute("data-attachment-status", "done"));
    fireEvent.click(within(chip()).getByRole("button", { name: "Remove a.txt" }));
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });
});

// ── Slash menu ──────────────────────────────────────────────────────────────────────────────────

describe("ChatComposer: slash menu", () => {
  it("lists the catalog, inserts a command that takes an argument, two taps for a dangerous one", async () => {
    show();
    type("/");
    const list = screen.getByRole("listbox", { name: "Commands" });
    expect(within(list).getByText("/compact")).toBeInTheDocument();
    fireEvent.click(within(list).getByText("/compact"));
    expect(box().value).toBe("/compact ");
    expect(posts).toHaveLength(0);

    type("/cle");
    fireEvent.click(within(screen.getByRole("listbox")).getByText("/clear"));
    expect(posts).toHaveLength(0);
    expect(screen.getByText("Tap again to run")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("listbox")).getByText("/clear"));
    await waitFor(() => expect(commands("message.dispatch")).toEqual([expect.objectContaining({ text: "/clear", mode: "start" })]));
  });

  it("the operator's rows replace the catalog on a thread they address; a no-arg row sends on pick", async () => {
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: false,
          vapidPublicKey: "",
          operatorCommands: [{ agent: "claude", command: "/deploy", description: "Ship it", takesArg: false, argHint: "" }],
        }),
      ),
    );
    show();
    type("/");
    await waitFor(() => expect(within(screen.getByRole("listbox")).getByText("/deploy")).toBeInTheDocument());
    expect(within(screen.getByRole("listbox")).queryByText("/compact")).toBeNull();
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(commands("message.dispatch")).toEqual([expect.objectContaining({ text: "/deploy" })]));
  });
});

// ── Keys pad ────────────────────────────────────────────────────────────────────────────────────

describe("ChatComposer: Keys pad", () => {
  it("opens in flow on a phone and sends keys through the pane's key route", async () => {
    const sent: unknown[] = [];
    server.use(
      http.post("/api/pane/:paneId/keys", async ({ request, params }) => {
        sent.push({ paneId: params.paneId, ...((await request.json()) as object) });
        return HttpResponse.json({ ok: true });
      }),
    );
    show();
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    const dock = document.querySelector("[data-keys-dock]")!;
    expect(dock).not.toBeNull();
    expect(dock.closest("[role=dialog]")).toBeNull();
    fireEvent.click(within(dock as HTMLElement).getByRole("button", { name: "Esc" }));
    await waitFor(() => expect(sent).toEqual([{ paneId: "p-t1", keys: ["Escape"] }]));
  });

  it("is not offered at desktop width", () => {
    setViewportWidth(1200);
    show();
    expect(screen.queryByRole("button", { name: "Keys" })).toBeNull();
  });
});

// ── Request panel ───────────────────────────────────────────────────────────────────────────────

describe("ChatComposer: a pending request replaces the box", () => {
  it("permission: options as buttons, destructive last and two taps, busy until it leaves pending", async () => {
    show({ thread: { status: "approval" }, requests: [request()] });
    expect(screen.queryByLabelText("Message")).toBeNull();
    const panel = screen.getByRole("region", { name: "The agent is asking" });
    const buttons = within(panel).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Yes", "No"]);
    fireEvent.click(buttons[1]!);
    expect(posts).toHaveLength(0);
    expect(buttons[1]).toHaveTextContent("Tap again to confirm");
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(commands("runtime-request.respond")).toEqual([expect.objectContaining({ requestId: "r1", optionIndex: 1 })]));
    expect(within(panel).getAllByRole("button")[1]).toHaveAttribute("aria-busy", "true");
    patchThread((s) => ({ requests: { r1: { ...s.requests.r1!, status: "resolved" } } }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeInTheDocument());
    expect(screen.queryByText("Answered elsewhere.")).toBeNull();
  });

  it("question with options posts the picked option", async () => {
    show({
      thread: { status: "input" },
      requests: [request({ kind: "question", prompt: "Which one?", options: [{ label: "A", keys: ["1"] }, { label: "B", keys: ["2"] }] })],
    });
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    await waitFor(() => expect(commands("runtime-request.respond")).toEqual([expect.objectContaining({ optionIndex: 1 })]));
  });

  it("question with no options: the prompt and Open terminal", () => {
    show({ thread: { status: "input" }, requests: [request({ kind: "question", prompt: "Type a name", options: [] })] });
    expect(screen.getByText("Answer in the Terminal tab.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    // T13: the Terminal tab (a sheet here, at the test's phone width), not v1's pane page.
    expect(useRightPanelStore.getState().sheet ?? useRightPanelStore.getState().activeSurfaceId).toBe("terminal");
    expect(useRightPanelStore.getState().directTyping).toBeNull();
  });

  it("menu: the options in order", async () => {
    show({
      thread: { status: "approval" },
      requests: [request({ kind: "menu", prompt: "Pick", options: [{ label: "One", keys: ["Enter"] }, { label: "Two", keys: ["Down", "Enter"] }] })],
    });
    const panel = screen.getByRole("region", { name: "The agent is asking" });
    expect(within(panel).getAllByRole("button").map((b) => b.textContent)).toEqual(["One", "Two"]);
    fireEvent.click(within(panel).getByRole("button", { name: "Two" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sent to the agent."));
  });

  it("the last answer's verdict does not carry over to the next request's card (T18)", async () => {
    show({
      thread: { status: "approval" },
      requests: [request({ kind: "menu", prompt: "Pick", options: [{ label: "One", keys: ["Enter"] }, { label: "Two", keys: ["Down", "Enter"] }] })],
    });
    fireEvent.click(screen.getByRole("button", { name: "One" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sent to the agent."));
    // The answered dialog leaves the screen and the next one comes up (a wizard's next step).
    patchThread((cur) => ({
      requests: {
        r1: { ...cur.requests.r1!, status: "resolved" },
        r2: request({ id: "r2", kind: "question", prompt: "Next?", options: [{ label: "A", keys: ["1"] }], createdAt: 2 }),
      },
    }));
    expect(await screen.findByText("Next?")).toBeInTheDocument();
    expect(screen.queryByText("Sent to the agent.")).toBeNull();
    expect(screen.queryByText("Answered elsewhere.")).toBeNull();
  });

  it("a reply that lands after the next card is up says nothing under that card (live: Claude's second Read)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post("/api/v2/command", async () => {
        await gate;
        return HttpResponse.json({ ok: true, sequence: 400 });
      }),
    );
    show({
      thread: { status: "approval" },
      requests: [request({ kind: "menu", prompt: "Pick", options: [{ label: "One", keys: ["Enter"] }] })],
    });
    fireEvent.click(screen.getByRole("button", { name: "One" }));
    // The bridge publishes the next dialog before its reply to the respond arrives.
    patchThread((cur) => ({
      requests: {
        r1: { ...cur.requests.r1!, status: "resolved" },
        r2: request({ id: "r2", kind: "permission", prompt: "Do you want to proceed?", createdAt: 2 }),
      },
    }));
    expect(await screen.findByText("Do you want to proceed?")).toBeInTheDocument();
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByText("Sent to the agent.")).toBeNull();
    expect(screen.getByRole("button", { name: "Yes" })).not.toHaveAttribute("aria-busy");
  });

  it("password: no input, no options, Open terminal", () => {
    show({ thread: { status: "approval" }, requests: [request({ kind: "password", prompt: "[sudo] password:", options: [] })] });
    const panel = screen.getByRole("region", { name: "The agent is asking" });
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(within(panel).getAllByRole("button").map((b) => b.textContent)).toEqual(["Open terminal"]);
    expect(within(panel).getByText(/Sightr does not send it/)).toBeInTheDocument();
    // T13: Open terminal opens the Terminal tab and asks it to arm direct typing, naming the prompt.
    fireEvent.click(within(panel).getByRole("button", { name: "Open terminal" }));
    expect(useRightPanelStore.getState().directTyping).toMatchObject({ threadId: "t1", prompt: "[sudo] password:" });
  });

  it("a whistlr request is a decision card: its options as buttons, nothing posted until a tap (T19)", () => {
    show({ thread: { status: "approval" }, requests: [request({ via: "whistlr", decision: { thread: "th", run: "rn" } })] });
    const panel = screen.getByRole("region", { name: "The agent is asking" });
    expect(within(panel).getByText("Decision for the operator")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Yes" })).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  it("expired without an answer from here: the box comes back with Answered elsewhere", async () => {
    show({ thread: { status: "approval" }, requests: [request()] });
    patchThread((s) => ({ requests: { r1: { ...s.requests.r1!, status: "expired" } } }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeInTheDocument());
    expect(screen.getByText("Answered elsewhere.")).toBeInTheDocument();
  });

  it("focus: the first safe option takes focus, but never from the box", async () => {
    const { unmount } = show({ thread: { status: "approval" }, requests: [request()] });
    expect(screen.getByRole("button", { name: "Yes" })).toHaveFocus();
    unmount();
    show({ thread: { status: "working" } });
    box().focus();
    patchThread(() => ({ requests: { r1: request() } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Yes" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Yes" })).not.toHaveFocus();
  });

  it("announces a new request (aria-live) in a labelled region", () => {
    show({ thread: { status: "approval" }, requests: [request()] });
    const live = document.querySelector("[aria-live=assertive]")!;
    expect(live).toHaveTextContent("The agent is asking: Run `rm build`?");
  });
});

// ── Banners ─────────────────────────────────────────────────────────────────────────────────────

describe("ChatComposer: banners", () => {
  it("a lost link disables Send and keeps the draft", () => {
    show();
    type("wait for it");
    act(() => useStreamHealth.setState({ status: "lost" }));
    expect(screen.getByText("Not connected. Sending is paused.", { selector: "span.font-medium" })).toBeInTheDocument();
    expect(primary()).toBeDisabled();
    expect(box().value).toBe("wait for it");
    expect(loadDraft("t1")).toBe("wait for it");
  });

  it("herdr down and read-only", () => {
    show();
    act(() => useBridgeInfo.setState({ herdr: "disconnected", readOnly: true }));
    expect(screen.getByText("Herdr is not reachable on the host.")).toBeInTheDocument();
    expect(screen.getByText("This device is read-only.", { selector: "span.font-medium" })).toBeInTheDocument();
    expect(box()).toBeDisabled();
  });

  it("a dispatch.failed for this client's send: the reason, the text back in the box, and Retry", async () => {
    show();
    type("try this");
    fireEvent.click(primary()!);
    await waitFor(() => expect(box().value).toBe(""));
    const commandId = commands("message.dispatch")[0]!.commandId as string;
    act(() => {
      const current = useThreadStore.getState().current!;
      useThreadStore.setState({
        current: applyThreadEvent(current, {
          sequence: 500,
          threadId: "t1",
          commandId,
          type: "dispatch.failed",
          payload: { reason: "stalled" },
          ts: 1,
        }),
      });
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("did not reach the agent's input box"));
    expect(box().value).toBe("try this");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(commands("message.dispatch")).toHaveLength(2));
    expect(commands("message.dispatch")[1]).toMatchObject({ text: "try this" });
  });

  it("a textDelivered failure offers no Retry", async () => {
    show();
    act(() => {
      const current = useThreadStore.getState().current!;
      useThreadStore.setState({
        current: applyThreadEvent(current, {
          sequence: 500,
          threadId: "t1",
          type: "dispatch.failed",
          payload: { reason: "error", textDelivered: true },
          ts: 1,
        }),
      });
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not submitted"));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("a failed run says so and can be dismissed", () => {
    show({ runs: [{ id: "run1", threadId: "t1", ordinal: 0, status: "failed", startedAt: 1, completedAt: 2 }] });
    expect(screen.getByText("The last run failed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("The last run failed.")).toBeNull();
  });
});

// ── T13: the composer's keys come from the keybinding table ─────────────────────────────────────

describe("ChatComposer: keybinding table", () => {
  it("mod+enter in the focused box sends the other follow-up while the agent works", async () => {
    setViewportWidth(1200);
    show({ thread: { status: "working" } });
    type("b");
    box().focus();
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(commands("message.dispatch")[0]).toMatchObject({ mode: "steer", text: "b" }));
  });

  it("mod+shift+enter never types a newline and steers only when it can", () => {
    show({ thread: { status: "idle" } });
    box().focus();
    const event = createEvent.keyDown(box(), { key: "Enter", ctrlKey: true, shiftKey: true });
    fireEvent(box(), event);
    expect(event.defaultPrevented).toBe(true);
    expect(posts).toHaveLength(0);
  });
}
);
