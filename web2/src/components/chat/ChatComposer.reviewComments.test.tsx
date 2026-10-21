// T29: pending line comments meet the composer. Add appends the blocks to the draft and saves it; the send path is the
// ordinary one (the primary button decides Send, Queue or Steer); comments clear only when the dispatch reply returns.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { NO_CAPABILITIES, type QueuedMessage, type RuntimeRequest, type Thread } from "@shared/v2/contracts";
import { useMessageToasts } from "@/components/toast";
import { loadDraft, saveDraft } from "@/lib/drafts";
import { formatReviewBlock, reviewBlocksIn } from "@/lib/reviewCommentContext";
import { useRightPanelStore } from "@/rightPanelStore";
import { __setComposerDeps, requestInsert, setFollowUp } from "@/state/composer";
import { useCommentsListOpen } from "@/state/commentsUi";
import { addLineComment, getLineComments, reanchorFile } from "@/state/lineComments";
import { applyThreadEvent, threadFromSnapshot } from "@/stream/apply";
import { useBridgeInfo, useStreamHealth, useThreadStore } from "@/stream/stores";
import { thread as threadFixture } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";
import { parsePatch } from "@/components/diffs/parsePatch";

import { ChatComposer } from "./ChatComposer";

const ALL = { ...NO_CAPABILITIES, hasJournal: true, canInterrupt: true, canQueueDrain: true, interruptKeys: ["Escape"] };

let posts: Record<string, unknown>[] = [];
let reply: (body: Record<string, unknown>) => Response | undefined = () => undefined;

beforeEach(() => {
  posts = [];
  reply = () => undefined;
  setViewportWidth(1200);
  let n = 0;
  let seq = 100;
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

function show(opts: { thread?: Partial<Thread>; queue?: QueuedMessage[]; requests?: RuntimeRequest[] } = {}) {
  useThreadStore.setState({
    current: threadFromSnapshot(
      { sequence: 1, thread: threadFixture("t1", { capabilities: ALL, ...opts.thread }), runs: [], items: [], requests: opts.requests ?? [], queue: opts.queue ?? [], historyCursor: null },
      false,
    ),
    missing: null,
  });
  return render(<ChatComposer threadId="t1" />);
}

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const primary = () => document.querySelector<HTMLButtonElement>("[data-primary-kind]");
const commands = (t: string) => posts.filter((p) => p.type === t);
const bar = () => document.querySelector<HTMLElement>("[data-review-comments-bar]");
const toasts = () => useMessageToasts.getState().toasts.map((t) => t.text);

const comment = (note: string, over: Partial<Parameters<typeof addLineComment>[1]> = {}) => {
  const r = addLineComment("t1", { path: "src/a.ts", side: "new", start: 3, end: 3, quote: ["+const a = 1;"], note, ...over });
  if (!r.ok) throw new Error(r.reason);
  return r.comment;
};
const blockOf = (c: ReturnType<typeof comment>) => formatReviewBlock(c);
const getListOpen = () => {
  let open = false;
  const Probe = () => ((open = useCommentsListOpen("t1")), null);
  render(<Probe />);
  return open;
};

describe("Add to message", () => {
  it("appends the blocks after a blank line, saves the draft, and says what it added", () => {
    const [a, b] = [comment("one"), comment("two", { path: "src/b.ts" })];
    saveDraft("t1", "please fix these");
    show();
    expect(bar()).toHaveTextContent("2 review comments");
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to message" }));
    expect(box().value).toBe(`please fix these\n\n${blockOf(a)}\n\n${blockOf(b)}`);
    expect(loadDraft("t1")).toBe(box().value);
    expect(toasts()).toContain("Added 2 comments to your message.");
    // They stay in the list (the basket) and are marked as in the message; Add has nothing left to add.
    expect(getLineComments("t1")).toHaveLength(2);
    expect(bar()).toHaveTextContent("(2 in message)");
    expect(within(bar()!).getByRole("button", { name: "Add to message" })).toBeDisabled();
  });

  it("into an empty box the block is the whole message, and a desktop focuses the box", () => {
    const a = comment("only");
    show();
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to message" }));
    expect(box().value).toBe(blockOf(a));
    expect(box()).toHaveFocus();
  });

  it("a phone closes the Diff sheet and does not focus the box (no surprise keyboard)", () => {
    setViewportWidth(390);
    comment("only");
    act(() => useRightPanelStore.getState().openSheet("diff"));
    show();
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to message" }));
    expect(useRightPanelStore.getState().sheet).toBeNull();
    expect(box().value).toContain("[review] src/a.ts:3 (new)");
    expect(box()).not.toHaveFocus();
    expect(getListOpen()).toBe(false); // and the Diff tab opens on its files next time
  });

  it("the text it adds is plain: it starts with [ and the same blocks parse back", () => {
    comment("n1\n\n> not a quote of mine");
    show();
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to message" }));
    expect(box().value.startsWith("[")).toBe(true);
    expect(reviewBlocksIn(box().value)).toHaveLength(1);
    expect(screen.queryByRole("listbox")).toBeNull(); // the slash menu stays shut
  });

  it("stops before 10 comments a message and says how many went in", () => {
    for (let i = 0; i < 12; i++) comment(`n${i}`, { path: `src/f${i}.ts` });
    show();
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to message" }));
    expect(reviewBlocksIn(box().value)).toHaveLength(10);
    expect(toasts()).toContain("Added 10 of 12. Send, then add the rest.");
  });

  it("says the message is full, not 'Added 0 of 1', when the text would pass the composer's limit", () => {
    comment("one");
    show();
    const full = "x".repeat(64 * 1024 - 5);
    type(full);
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to message" }));
    expect(box().value).toBe(full);
    expect(toasts()).toContain("Your message is full. Send, then add the rest.");
    expect(toasts().some((t) => t.startsWith("Added 0 of"))).toBe(false);
  });

  it("leaves outdated comments for the list's confirm tap", () => {
    const fresh = comment("fresh");
    comment("stale", { path: "src/old.ts" });
    reanchorFile("t1", "src/old.ts", parsePatch(["diff --git a/src/old.ts b/src/old.ts", "--- a/src/old.ts", "+++ b/src/old.ts", "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n"))[0]!);
    show();
    expect(bar()).toHaveTextContent("(1 outdated)");
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to message" }));
    expect(box().value).toBe(blockOf(fresh));
  });
});

describe("what Add does not change", () => {
  it("a working thread keeps Queue or Steer by the setting, with the block in the box", async () => {
    comment("note");
    show({ thread: { status: "working" } });
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to message" }));
    expect(primary()).toHaveAccessibleName("Queue");
    act(() => setFollowUp("steer"));
    expect(primary()).toHaveAccessibleName("Steer");
    fireEvent.click(primary()!);
    await waitFor(() => expect(commands("message.dispatch")[0]).toMatchObject({ mode: "steer" }));
    expect((commands("message.dispatch")[0] as { text: string }).text).toContain("[review] src/a.ts:3 (new)");
  });

  it("a plain shell thread: the row stays, Add is off and says why", () => {
    comment("note");
    show({ thread: { capabilities: { ...ALL, canQueueDrain: false } } });
    expect(within(bar()!).getByRole("button", { name: "Add to message" })).toBeDisabled();
    expect(bar()).toHaveTextContent("This pane is a shell");
    expect(box().value).toBe("");
  });

  it("a read-only device cannot add", () => {
    comment("note");
    act(() => useBridgeInfo.setState({ readOnly: true }));
    show();
    expect(within(bar()!).getByRole("button", { name: "Add to message" })).toBeDisabled();
  });

  it("the destructive-text guard still scans the whole message: quoted rm -rf asks for a second tap", async () => {
    comment("remove the rm -rf build step", { quote: ["-rm -rf build"] });
    show();
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to message" }));
    fireEvent.click(primary()!);
    expect(commands("message.dispatch")).toHaveLength(0);
    expect(primary()).toHaveAccessibleName("Confirm");
    fireEvent.click(primary()!);
    await waitFor(() => expect(commands("message.dispatch")).toHaveLength(1));
  });
});

describe("while a request is pending, the box stays usable (T37)", () => {
  const ask: RuntimeRequest = {
    id: "r1",
    threadId: "t1",
    kind: "permission",
    prompt: "Run `ls`?",
    options: [{ label: "Yes", keys: ["1"] }, { label: "No", keys: ["3"] }],
    status: "pending",
    bindingHash: "h",
    createdAt: 1,
    updatedAt: 1,
  };

  it("keeps the row and the box, so an Add from the Diff panel still updates the draft and the toast says the message is waiting", async () => {
    const a = comment("note");
    show({ requests: [ask] });
    expect(bar()).not.toBeNull();
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
    act(() => requestInsert("t1", [blockOf(a)]));
    await waitFor(() => expect(loadDraft("t1")).toBe(blockOf(a)));
    expect(toasts()).toContain("Added 1 comment to your message. The agent is asking something; your message is waiting.");
  });
});

describe("a queued message being edited", () => {
  it("Add appends to the edit buffer, not the saved draft", async () => {
    const a = comment("note");
    saveDraft("t1", "my draft");
    const row: QueuedMessage = { id: "q1", threadId: "t1", text: "queued one", attachments: [], position: 0, mode: "queue", state: "queued", createdAt: 1 };
    show({ thread: { status: "working" }, queue: [row] });
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    expect(box().value).toBe("queued one");
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to message" }));
    expect(box().value).toBe(`queued one\n\n${blockOf(a)}`);
    expect(loadDraft("t1")).toBe("my draft");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(commands("queued.edit")).toHaveLength(1));
    expect((commands("queued.edit")[0] as { text: string }).text).toContain("[review]");
    await waitFor(() => expect(getLineComments("t1")).toHaveLength(0)); // saveQueuedEdit's reply consumed the block
  });
});

describe("clearing on send", () => {
  it("deletes the comments whose block went out, only on the bridge's reply, and keeps the rest", async () => {
    const a = comment("sent");
    const b = comment("kept", { path: "src/b.ts" });
    show();
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to message" }));
    // Take the second block out of the box before sending: only the first is in the sent text.
    type(blockOf(a));
    fireEvent.click(primary()!);
    await waitFor(() => expect(commands("message.dispatch")).toHaveLength(1));
    await waitFor(() => expect(getLineComments("t1").map((c) => c.id)).toEqual([b.id]));
    await waitFor(() => expect(box().value).toBe(""));
  });

  it("a refused send (500) keeps the comments and the text", async () => {
    comment("note");
    reply = () => HttpResponse.json({ ok: false, error: "boom" }, { status: 500 });
    show();
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to message" }));
    const text = box().value;
    fireEvent.click(primary()!);
    await waitFor(() => expect(commands("message.dispatch")).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(getLineComments("t1")).toHaveLength(1);
    expect(box().value).toBe(text);
  });

  it("a dispatch.failed after the reply puts the text back: the blocks in the box are then the copy", async () => {
    comment("note");
    show();
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to message" }));
    const text = box().value;
    fireEvent.click(primary()!);
    await waitFor(() => expect(box().value).toBe(""));
    expect(getLineComments("t1")).toHaveLength(0);
    const commandId = commands("message.dispatch")[0]!.commandId as string;
    act(() => {
      useThreadStore.setState({
        current: applyThreadEvent(useThreadStore.getState().current!, { sequence: 500, threadId: "t1", commandId, type: "dispatch.failed", payload: { reason: "stalled" }, ts: 1 }),
      });
    });
    await waitFor(() => expect(box().value).toBe(text));
  });
});

describe("the row", () => {
  it("View opens the Diff tab on the comments list", () => {
    comment("note");
    show();
    fireEvent.click(within(bar()!).getByRole("button", { name: "View" }));
    expect(getListOpen()).toBe(true);
    expect(useRightPanelStore.getState()).toMatchObject({ isOpen: true, activeSurfaceId: "diff" });
  });

  it("Discard needs a second tap", () => {
    comment("note");
    show();
    fireEvent.click(within(bar()!).getByRole("button", { name: "Discard" }));
    expect(getLineComments("t1")).toHaveLength(1);
    expect(within(bar()!).getByRole("button", { name: "Tap again to discard" })).toBeInTheDocument();
    fireEvent.click(within(bar()!).getByRole("button", { name: "Tap again to discard" }));
    expect(getLineComments("t1")).toHaveLength(0);
    expect(bar()).toBeNull();
  });

  it("shows nothing when there are no comments", () => {
    show();
    expect(bar()).toBeNull();
  });
});
