import { describe, expect, it } from "vitest";

import { NO_CAPABILITIES, type QueuedMessage, type Thread } from "@shared/v2/contracts";

import {
  firstLine,
  heldReasonText,
  isLargePaste,
  LARGE_PASTE_CHARS,
  orderRequestOptions,
  queueHeldSummary,
  resolveComposerButtons,
  resolveEnterAction,
  slashQuery,
  wantsEditNewest,
  type ButtonInput,
} from "./ChatComposer.logic";

const ALL = { ...NO_CAPABILITIES, canInterrupt: true, canQueueDrain: true };
const QUEUE_ONLY = { ...NO_CAPABILITIES, canQueueDrain: true };
const STOP_ONLY = { ...NO_CAPABILITIES, canInterrupt: true };

function input(status: Thread["status"], over: Partial<ButtonInput> = {}, caps = ALL): ButtonInput {
  return {
    thread: { status, shelf: "active", capabilities: caps },
    hasRequest: false,
    hasText: false,
    followUp: "queue",
    alternate: false,
    editing: false,
    busy: false,
    linkLost: false,
    readOnly: false,
    uploading: false,
    ...over,
  };
}

describe("resolveComposerButtons: the button table", () => {
  it.each(["idle", "done", "failed"] as const)("%s: disabled Send when empty, Send (start) with text", (status) => {
    expect(resolveComposerButtons(input(status)).primary).toMatchObject({ kind: "send", label: "Send", disabled: true });
    expect(resolveComposerButtons(input(status, { hasText: true })).primary).toMatchObject({ kind: "send", disabled: false });
    expect(resolveComposerButtons(input(status, { hasText: true })).stop).toBe(false);
  });

  it("working, empty: Stop", () => {
    expect(resolveComposerButtons(input("working")).primary).toMatchObject({ kind: "stop", label: "Stop", disabled: false });
  });

  it("working with text: Queue or Steer by the setting, Stop beside it", () => {
    const q = resolveComposerButtons(input("working", { hasText: true }));
    expect(q.primary).toMatchObject({ kind: "queue", label: "Queue", disabled: false });
    expect(q.stop).toBe(true);
    const s = resolveComposerButtons(input("working", { hasText: true, followUp: "steer" }));
    expect(s.primary).toMatchObject({ kind: "steer", label: "Steer" });
  });

  it("mod (alternate) flips Queue and Steer", () => {
    expect(resolveComposerButtons(input("working", { hasText: true, alternate: true })).primary.kind).toBe("steer");
    expect(resolveComposerButtons(input("working", { hasText: true, followUp: "steer", alternate: true })).primary.kind).toBe("queue");
  });

  it("Steer only with canInterrupt && canQueueDrain; without canInterrupt it reads Queue, with no Stop", () => {
    const b = resolveComposerButtons(input("working", { hasText: true, followUp: "steer" }, QUEUE_ONLY));
    expect(b.primary.kind).toBe("queue");
    expect(b.stop).toBe(false);
  });

  it("no canQueueDrain (a plain shell): Stop alone while it works, text or not", () => {
    expect(resolveComposerButtons(input("working", { hasText: true }, STOP_ONLY)).primary.kind).toBe("stop");
    const none = resolveComposerButtons(input("working", { hasText: true }, NO_CAPABILITIES));
    expect(none.primary).toMatchObject({ kind: "send", disabled: true });
    expect(none.stop).toBe(false);
  });

  it("a pending request owns the area", () => {
    expect(resolveComposerButtons(input("approval", { hasRequest: true })).requestPanel).toBe(true);
    expect(resolveComposerButtons(input("input", { hasRequest: true, hasText: true })).requestPanel).toBe(true);
  });

  it("pane gone, read-only device and a lost link disable Send with the reason", () => {
    const gone = input("idle", { hasText: true });
    gone.thread = { ...gone.thread!, shelf: "archived" };
    expect(resolveComposerButtons(gone).primary).toMatchObject({ disabled: true, reason: "The pane is gone." });
    expect(resolveComposerButtons(input("idle", { hasText: true, readOnly: true })).primary).toMatchObject({
      disabled: true,
      reason: "This device is read-only.",
    });
    expect(resolveComposerButtons(input("working", { hasText: true, linkLost: true })).primary).toMatchObject({
      disabled: true,
      reason: "Not connected. Sending is paused.",
    });
  });

  it("a command in flight disables the button (no double post)", () => {
    expect(resolveComposerButtons(input("idle", { hasText: true, busy: true })).primary.disabled).toBe(true);
    expect(resolveComposerButtons(input("working", { hasText: true, busy: true })).primary.disabled).toBe(true);
  });

  it("editing a queued message: Update", () => {
    expect(resolveComposerButtons(input("working", { hasText: true, editing: true })).primary).toMatchObject({
      kind: "update",
      disabled: false,
    });
  });
});

const key = (k: string, mods: Partial<{ shift: boolean; ctrl: boolean; meta: boolean; alt: boolean }> = {}, extra = {}) => ({
  key: k,
  shiftKey: !!mods.shift,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  altKey: !!mods.alt,
  ...extra,
});

describe("resolveEnterAction", () => {
  it("Enter sends; Shift+Enter adds a line; Mod+Enter sends the other follow-up", () => {
    expect(resolveEnterAction(key("Enter"), "enter")).toBe("submit");
    expect(resolveEnterAction(key("Enter", { shift: true }), "enter")).toBe("newline");
    expect(resolveEnterAction(key("Enter", { ctrl: true }), "enter")).toBe("submit-alternate");
    expect(resolveEnterAction(key("Enter", { meta: true }), "enter")).toBe("submit-alternate");
  });

  it("Mod+Enter sends; Enter adds a line", () => {
    expect(resolveEnterAction(key("Enter"), "mod-enter")).toBe("newline");
    expect(resolveEnterAction(key("Enter", { ctrl: true }), "mod-enter")).toBe("submit");
    expect(resolveEnterAction(key("Enter", { ctrl: true, alt: true }), "mod-enter")).toBe("submit-alternate");
  });

  it("IME composition and keyCode 229 never send", () => {
    expect(resolveEnterAction(key("Enter", {}, { isComposing: true }), "enter")).toBeNull();
    expect(resolveEnterAction(key("Enter", {}, { keyCode: 229 }), "enter")).toBeNull();
    expect(resolveEnterAction(key("Enter", { ctrl: true }, { isComposing: true }), "mod-enter")).toBeNull();
  });

  it("Mod+Shift+Enter steers the oldest queued message", () => {
    expect(resolveEnterAction(key("Enter", { ctrl: true, shift: true }), "enter")).toBe("steer-oldest");
    expect(resolveEnterAction(key("Enter", { meta: true, shift: true }), "mod-enter")).toBe("steer-oldest");
  });

  it("Alt+ArrowUp edits the newest queued only from the start of an empty box", () => {
    expect(wantsEditNewest(key("ArrowUp", { alt: true }), "", 0)).toBe(true);
    expect(wantsEditNewest(key("ArrowUp", { alt: true }), "x", 0)).toBe(false);
    expect(wantsEditNewest(key("ArrowUp"), "", 0)).toBe(false);
  });
});

describe("small rules", () => {
  it("slashQuery: a `/` at the start, no space yet", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/com")).toBe("com");
    expect(slashQuery("/compact now")).toBeNull();
    expect(slashQuery("hi /x")).toBeNull();
  });

  it("isLargePaste at 32 KiB", () => {
    expect(isLargePaste("a".repeat(LARGE_PASTE_CHARS - 1))).toBe(false);
    expect(isLargePaste("a".repeat(LARGE_PASTE_CHARS))).toBe(true);
  });

  it("held reasons in words; a restart-only hold says Paused after restart", () => {
    expect(heldReasonText("restart")).toBe("Paused after restart");
    expect(heldReasonText("pane-closed")).toBe("Not sent: pane closed");
    const row = (over: Partial<QueuedMessage>): QueuedMessage => ({
      id: "q",
      threadId: "t1",
      text: "x",
      attachments: [],
      position: 0,
      mode: "queue",
      state: "queued",
      createdAt: 1,
      ...over,
    });
    expect(queueHeldSummary([row({ state: "held", heldReason: "restart" })])).toEqual({ held: true, restart: true, resumable: true });
    expect(queueHeldSummary([row({ state: "held", heldReason: "pane-closed" })]).resumable).toBe(false);
    expect(queueHeldSummary([row({})]).held).toBe(false);
  });

  it("firstLine", () => {
    expect(firstLine("one\ntwo")).toBe("one");
  });

  it("orderRequestOptions puts destructive options last and keeps each index", () => {
    const out = orderRequestOptions([
      { label: "No", keys: ["3"], destructive: true },
      { label: "Yes", keys: ["1"] },
      { label: "Always", keys: ["2"] },
    ]);
    expect(out.map((o) => [o.option.label, o.index])).toEqual([
      ["Yes", 1],
      ["Always", 2],
      ["No", 0],
    ]);
  });
});
