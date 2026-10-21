import { describe, expect, it } from "vitest";

import { capabilitiesFor, launchFor } from "@shared/agents";
import { NO_CAPABILITIES, type QueuedMessage, type Run, type Thread, type TurnItem } from "@shared/v2/contracts";

import {
  agoLabel,
  composerMaxHeight,
  enterModeFor,
  firstLine,
  heldReasonText,
  isCompacting,
  isLargePaste,
  isNativeMaintenanceCommand,
  LARGE_PASTE_CHARS,
  MAX_COMPOSER_CHARS,
  orderRequestOptions,
  permissionModeBlock,
  permissionModeOptions,
  permissionModeRefusalText,
  promptLengthMessage,
  queueAutoResumeText,
  queueHeldSummary,
  resolveComposerButtons,
  resolveEnterAction,
  slashQuery,
  threadStatusLine,
  wantsEditNewest,
  workingMode,
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

  it("a pending request keeps the box usable: the primary queues (T37)", () => {
    const empty = resolveComposerButtons(input("approval", { hasRequest: true }));
    expect(empty.requestPanel).toBe(true);
    expect(empty.primary).toMatchObject({ kind: "queue", label: "Queue", disabled: false });
    expect(empty.primary.reason).toBe("The agent is asking; type a message to queue it.");
    const typed = resolveComposerButtons(input("input", { hasRequest: true, hasText: true }));
    expect(typed.requestPanel).toBe(true);
    expect(typed.primary.kind).toBe("queue");
    expect(typed.primary.reason).toBe("The agent is asking; your message waits in the queue.");
    expect(typed.stop).toBe(false);
  });

  it("a pending request on a thread that cannot queue stays disabled (T37)", () => {
    const b = resolveComposerButtons(input("approval", { hasRequest: true, hasText: true }, NO_CAPABILITIES));
    expect(b.requestPanel).toBe(true);
    expect(b.primary).toMatchObject({ kind: "send", disabled: true });
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

  it("queueAutoResumeText counts the messages the bridge put back", () => {
    expect(queueAutoResumeText(1)).toBe("A queued message resumed automatically after the restart.");
    expect(queueAutoResumeText(3)).toBe("3 queued messages resumed automatically after the restart.");
    expect(queueAutoResumeText(0)).toBe("Queued messages resumed automatically after the restart.");
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

describe("compaction (T3 #20184): canSteer", () => {
  const run = (id: string, ordinal: number, status: Run["status"], userItemId?: string): Run => ({
    id,
    threadId: "t1",
    ordinal,
    status,
    startedAt: ordinal,
    ...(userItemId ? { userItemId } : {}),
  });
  const user = (id: string, runId: string | null, text: string, createdAt = 1): TurnItem => ({
    id,
    threadId: "t1",
    runId,
    ordinal: createdAt,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
    type: "user_message",
    messageId: id,
    text,
    attachments: [],
  });

  it("isNativeMaintenanceCommand: /compact or /logout, trimmed, any case, no attachments", () => {
    expect(isNativeMaintenanceCommand({ text: " /Compact\n" })).toBe(true);
    expect(isNativeMaintenanceCommand({ text: "/logout", attachments: [] })).toBe(true);
    expect(isNativeMaintenanceCommand({ text: "/compact now" })).toBe(false);
    expect(isNativeMaintenanceCommand({ text: "/compact", attachments: [{ path: "C:/a.png", name: "a.png" }] })).toBe(false);
  });

  it("isCompacting: the newest run is running and started from /compact", () => {
    expect(isCompacting(null)).toBe(false);
    expect(isCompacting({ runs: { r1: run("r1", 1, "running", "u1") }, items: { u1: user("u1", "r1", "/compact") } })).toBe(true);
    // Attributed but not linked yet, and unclaimed (dispatch's own item before T03 adopts it).
    expect(isCompacting({ runs: { r1: run("r1", 1, "running") }, items: { u1: user("u1", "r1", "/compact") } })).toBe(true);
    expect(isCompacting({ runs: { r1: run("r1", 1, "running") }, items: { u1: user("u1", null, "/compact") } })).toBe(true);
    // Ended, a plain message, or an older run's /compact.
    expect(isCompacting({ runs: { r1: run("r1", 1, "completed", "u1") }, items: { u1: user("u1", "r1", "/compact") } })).toBe(false);
    expect(isCompacting({ runs: { r1: run("r1", 1, "running", "u1") }, items: { u1: user("u1", "r1", "fix it") } })).toBe(false);
    expect(
      isCompacting({
        runs: { r0: run("r0", 1, "completed", "u0"), r1: run("r1", 2, "running") },
        items: { u0: user("u0", "r0", "/compact") },
      }),
    ).toBe(false);
  });

  it("isCompacting: the bridge saw the harness compact on its own (thread.compacting, no /compact)", () => {
    const working = { runs: { r1: run("r1", 1, "running", "u1") }, items: { u1: user("u1", "r1", "fix it") } };
    expect(isCompacting({ ...working, thread: { compacting: true } })).toBe(true);
    expect(isCompacting({ ...working, thread: { compacting: false } })).toBe(false);
    expect(isCompacting({ runs: {}, items: {}, thread: { compacting: true } })).toBe(true);
  });

  it("canSteer false: the follow-up queues whatever the setting and the modifier say; Stop stays", () => {
    expect(workingMode("steer", false, ALL, false)).toBe("queue");
    expect(workingMode("queue", true, ALL, false)).toBe("queue");
    expect(workingMode("steer", false, ALL)).toBe("steer");
    const b = resolveComposerButtons(input("working", { hasText: true, followUp: "steer", canSteer: false }));
    expect(b.primary).toMatchObject({ kind: "queue", label: "Queue", disabled: false });
    expect(b.primary.reason).toMatch(/Compacting/);
    expect(b.stop).toBe(true);
    expect(resolveComposerButtons(input("working", { hasText: true, alternate: true, canSteer: false })).primary.kind).toBe("queue");
    // A queue-only harness never steers, so it says nothing about compaction.
    expect(resolveComposerButtons(input("working", { hasText: true, canSteer: false }, QUEUE_ONLY)).primary.reason).toBeNull();
  });
});

describe("phone: Enter mode and the box's height", () => {
  it("a touch screen defaults to Enter = newline, even at a desktop-wide layout; a stored choice wins", () => {
    expect(enterModeFor(null, "desktop", false)).toBe("enter");
    expect(enterModeFor(null, "desktop", true)).toBe("mod-enter");
    expect(enterModeFor(null, "phone", true)).toBe("mod-enter");
    expect(enterModeFor(null, "phone", false)).toBe("mod-enter");
    expect(enterModeFor("enter", "phone", true)).toBe("enter");
  });

  it("autosize stops at eight lines or the dvh cap, whichever is lower", () => {
    expect(composerMaxHeight(24, 8, Number.NaN)).toBe(24 * 8 + 16);
    expect(composerMaxHeight(24, 8, 120)).toBe(120);
    expect(composerMaxHeight(24, 8, 9999)).toBe(24 * 8 + 16);
    expect(composerMaxHeight(Number.NaN, 8, Number.NaN)).toBe(20 * 8 + 16);
  });
});

describe("permissionModeOptions", () => {
  it("lists the capability's modes in order with the launch table's labels; bypass is destructive", () => {
    expect(permissionModeOptions(capabilitiesFor("claude"), launchFor("claude")?.modes)).toEqual([
      { id: "manual", label: "Ask first", short: "Ask", destructive: false },
      { id: "acceptEdits", label: "Accept edits", short: "Edits", destructive: false },
      { id: "plan", label: "Plan", short: "Plan", destructive: false },
      { id: "auto", label: "Auto", short: "Auto", destructive: false },
      { id: "bypassPermissions", label: "Bypass permissions", short: "Bypass", destructive: true },
    ]);
  });

  it("is null without the flag or the list (Pi, a shell), so nothing renders", () => {
    expect(permissionModeOptions(capabilitiesFor("pi"), launchFor("pi")?.modes)).toBeNull();
    expect(permissionModeOptions(NO_CAPABILITIES, undefined)).toBeNull();
    expect(permissionModeOptions({ ...NO_CAPABILITIES, canSwitchPermissionMode: true }, undefined)).toBeNull();
    expect(permissionModeOptions(undefined, undefined)).toBeNull();
  });

  it("an id the launch table does not name keeps its id", () => {
    expect(permissionModeOptions({ ...NO_CAPABILITIES, canSwitchPermissionMode: true, permissionModes: ["yolo"] }, [])).toEqual([
      { id: "yolo", label: "yolo", short: "yolo", destructive: false },
    ]);
  });
});

describe("permissionModeBlock", () => {
  const base = { hasRequest: false, busy: false, readOnly: false, linkLost: false };
  const t = (status: Thread["status"], shelf: Thread["shelf"] = "active") => ({ status, shelf });
  it("only a resting thread (idle, done) with nothing pending can switch", () => {
    expect(permissionModeBlock({ ...base, thread: t("idle") })).toBeNull();
    expect(permissionModeBlock({ ...base, thread: t("done") })).toBeNull();
    expect(permissionModeBlock({ ...base, thread: t("working") })).toMatch(/working/);
    expect(permissionModeBlock({ ...base, thread: t("starting") })).toMatch(/starting/);
    expect(permissionModeBlock({ ...base, thread: t("failed") })).toMatch(/not at its prompt/);
    expect(permissionModeBlock({ ...base, thread: t("approval") })).toBe("Answer the agent first.");
    expect(permissionModeBlock({ ...base, thread: t("idle"), hasRequest: true })).toBe("Answer the agent first.");
    expect(permissionModeBlock({ ...base, thread: t("idle", "archived") })).toBe("The pane is gone.");
    expect(permissionModeBlock({ ...base, thread: t("idle"), readOnly: true })).toBe("This device is read-only.");
    expect(permissionModeBlock({ ...base, thread: t("idle"), linkLost: true })).toBe("Not connected.");
    expect(permissionModeBlock({ ...base, thread: t("idle"), busy: true })).toMatch(/last command/);
    expect(permissionModeBlock({ ...base, thread: null })).toMatch(/Loading/);
  });
});

describe("permissionModeRefusalText", () => {
  const label = (id: string) => ({ bypassPermissions: "Bypass permissions", plan: "Plan" })[id] ?? id;
  it("names the bridge's codes and the mode the footer showed", () => {
    expect(permissionModeRefusalText("thread-busy", undefined, label)).toMatch(/working/);
    expect(permissionModeRefusalText("needs-response", undefined, label)).toMatch(/answer/);
    expect(permissionModeRefusalText("blocked", undefined, label)).toMatch(/Nothing changed/);
    expect(permissionModeRefusalText("blocked", "plan", label)).toMatch(/It is now in Plan\./);
    expect(permissionModeRefusalText("bypass-reached", "bypassPermissions", label)).toMatch(/It is now in Bypass permissions/);
    expect(permissionModeRefusalText("mode-not-reached", "plan", label)).toMatch(/did not come up/);
    expect(permissionModeRefusalText("unknown-mode", undefined, label)).toMatch(/Terminal/);
    expect(permissionModeRefusalText("permission-mode-unsupported", undefined, label)).toMatch(/cannot be changed/);
    expect(permissionModeRefusalText("bypass-needs-confirm", undefined, label)).toMatch(/confirmed/);
    expect(permissionModeRefusalText("pane busy", undefined, label)).toBe("The mode did not change: pane busy.");
    expect(permissionModeRefusalText(undefined, undefined, label)).toBe("The mode did not change.");
  });
});

describe("promptLengthMessage", () => {
  it("is null under the cap and a message at it", () => {
    expect(promptLengthMessage("x".repeat(MAX_COMPOSER_CHARS - 1))).toBeNull();
    expect(promptLengthMessage("x".repeat(MAX_COMPOSER_CHARS))).toBe("At the 64 KB limit. Attach longer text as a file.");
  });
});

describe("threadStatusLine", () => {
  const wake = () => "2h";
  it("snoozed in the future, settled, or nothing", () => {
    expect(threadStatusLine({ shelf: "snoozed", snoozedUntil: 10_000 }, 1_000, wake)).toMatchObject({ label: "Snoozed, wakes in 2h", command: "thread.unsnooze" });
    expect(threadStatusLine({ shelf: "snoozed", snoozedUntil: 500 }, 1_000, wake)).toBeNull();
    expect(threadStatusLine({ shelf: "settled", settledAt: 0 }, 3 * 60_000, wake)).toMatchObject({ label: "Settled 3m ago", command: "thread.unsettle" });
    expect(threadStatusLine({ shelf: "settled" }, 0, wake)).toMatchObject({ label: "Settled" });
    expect(threadStatusLine({ shelf: "active" }, 0, wake)).toBeNull();
    expect(threadStatusLine({ shelf: "pinned" }, 0, wake)).toBeNull();
    expect(threadStatusLine(null, 0, wake)).toBeNull();
  });

  it("agoLabel steps from minutes to days", () => {
    expect(agoLabel(0, 30_000)).toBe("just now");
    expect(agoLabel(0, 5 * 60_000)).toBe("5m ago");
    expect(agoLabel(0, 2 * 3_600_000)).toBe("2h ago");
    expect(agoLabel(0, 3 * 86_400_000)).toBe("3d ago");
  });
});

describe("Stop and Steer for the shipped harnesses", () => {
  it("Pi and Claude can Stop and Steer (canInterrupt && canQueueDrain)", () => {
    for (const id of ["pi", "claude"]) {
      const caps = capabilitiesFor(id);
      const b = resolveComposerButtons({ ...input("working", { hasText: true, followUp: "steer" }), thread: { status: "working", shelf: "active", capabilities: caps } });
      expect(b.primary.kind).toBe("steer");
      expect(b.stop).toBe(true);
    }
  });
});
