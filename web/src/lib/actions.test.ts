import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { fetchPane, sendKeys, sendReply } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type MultiSelectModel } from "./blocks";
import { detectMenu } from "./harness/claude/menu";
import { detectMultiSelect } from "./harness/claude/multi-select";
import { detectPreviewSelect } from "./harness/claude/preview-select";
import { detectPromptSelect } from "./harness/claude/prompt-select";
import { grokAdapter } from "./harness/grok";
import * as actions from "./actions";
import { server } from "@/test/setup";
import * as registry from "./harness/registry";
const { menusEqual, menusSameIdentity, submitMenuKeys, multiSelectEquals, multiSelectIdentity, submitMultiSelectIntent, NOTE_MAX_LENGTH, previewsEqual, submitPreviewKeys, submitPreviewNote, submitPreviewOption, FEEDBACK_MAX_LENGTH, submitPromptFeedback, submitPromptOption, draftCarriesSend, sendGuardedReply } = actions;


vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
}));

const mockFetchPane = vi.mocked(fetchPane);
const mockSendReply = vi.mocked(sendReply);

describe("merged menu-action.test.ts", () => {

// The generic-menu race guard. The api layer is mocked so the pane can be made to drift between the
// render the user tapped and the read the guard takes; the detector is the real thing, driven by
// synthetic buffers in the /model picker's verified layout.


const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);

const RULE = "▔".repeat(60);

/** A synthetic picker in the verified layout; `at` places the ❯ highlight. */
function pickerBuffer(at = 1): string {
  const rows = ["Default", "Opus", "Fable"].map((label, i) => {
    const n = i + 1;
    return `${at === n ? "   ❯ " : "     "}${n}. ${label}`;
  });
  return [
    "some transcript above",
    RULE,
    "   Select model",
    "",
    ...rows,
    "",
    "   ◐ Medium effort ←/→ to adjust",
    "",
    "   Enter to set as default · s to use this session only · Esc to cancel",
  ].join("\n");
}

function menuAt(at = 1) {
  return detectMenu(splitLines(parseAnsi(pickerBuffer(at))))!;
}

const base = { paneId: "w1:p1", requestedLines: 200, detectedRevision: 0, agent: "claude" };

beforeEach(() => {
  vi.clearAllMocks();
  mockSendKeys.mockResolvedValue({ ok: true });
});

function pane(text: string) {
  mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text, truncated: false, revision: 0 });
}

describe("menusEqual / menusSameIdentity", () => {
  it("a moved highlight is the SAME screen but NOT the same render", () => {
    const a = menuAt(1);
    const b = menuAt(3);
    expect(menusSameIdentity(a, b)).toBe(true);
    expect(menusEqual(a, b)).toBe(false);
  });
});

describe("submitMenuKeys", () => {
  it("sends a footer-named key when the screen is unchanged", async () => {
    pane(pickerBuffer(1));
    const menu = menuAt(1);

    const res = await submitMenuKeys({ ...base, menu, keys: ["s"] });

    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["s"], menu.signature);
  });

  // The whole point of the strict guard: `Enter` here writes the user's DEFAULT model. A tap on a
  // render whose highlight has since moved must not commit against the row that is there now.
  it("refuses a committing key when the highlight moved underfoot", async () => {
    pane(pickerBuffer(3));

    const res = await submitMenuKeys({ ...base, menu: menuAt(1), keys: ["Enter"] });

    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  // An arrow's own effect IS moving the highlight, so a signature check would make every second
  // arrow tap fail. Identity is enough: nothing is committed.
  it("allows an arrow tap after the highlight moved (identity guard)", async () => {
    pane(pickerBuffer(3));

    const res = await submitMenuKeys({ ...base, menu: menuAt(1), keys: ["Down"], nav: true });

    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["Down"], expect.any(String));
  });

  it("refuses even an arrow once the picker is gone", async () => {
    pane("just ordinary output now");

    const res = await submitMenuKeys({ ...base, menu: menuAt(1), keys: ["Down"], nav: true });

    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});
});

describe("merged multi-select-action.test.ts", () => {

// The multi-select choreography engine: the entry guard + the Submit macro (walk the pointer DOWN
// onto "Submit", re-reading each step, then Enter) and the one-keystroke intents (toggle / escape /
// confirm / cancel). The api layer is mocked so the mid-flight pane states can be sequenced precisely;
// the detector is the real thing, driven by synthetic plain-text buffers in the verified layout.


const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);

type Pointer = "opt1" | "opt2" | "opt3" | "opt4" | "free" | "submit" | "chat" | "none";

// A synthetic checkbox screen in the verified layout: stepper, question, four checkbox rows, the
// free-text row, a navigable Submit row, a rule, the "Chat about this" escape, and the select footer.
// `pointer` places the ❯; `checked` marks rows.
function checkboxBuffer(
  opts: { pointer?: Pointer; checked?: number[]; question?: string } = {},
): string {
  const pointer = opts.pointer ?? "opt1";
  const checked = new Set(opts.checked ?? []);
  const labels = ["Cheese", "Mushrooms", "Olives", "Peppers"];
  const optRows = labels.map((label, i) => {
    const n = i + 1;
    const box = checked.has(n) ? "[✔]" : "[ ]";
    const ptr = pointer === `opt${n}` ? "❯ " : "  ";
    return `${ptr}${n}. ${box} ${label}`;
  });
  // The ❯ replaces the FIRST leading space (column alignment is preserved), so the pointer normalises
  // cleanly out of the signature — the un-pointed row is 5 spaces, the pointed one ❯ + 4.
  const submitRow = (pointer === "submit" ? "❯    " : "     ") + "Submit";
  const chatRow = (pointer === "chat" ? "❯ " : "  ") + "6. Chat about this";
  // The free-text "Type something" row can also carry the pointer (Claude lets the ❯ rest on it);
  // pointerAt classifies it as a non-Submit row, so the Submit walk must nudge past it, never Enter.
  const freeRow = (pointer === "free" ? "❯ " : "  ") + "5. [ ] Type something";
  return [
    "←  ☐ Toppings  ✔ Submit  →",
    "",
    opts.question ?? "Which pizza toppings do you want?",
    "",
    ...optRows,
    freeRow,
    submitRow,
    "─".repeat(80),
    chatRow,
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
}

function reviewBuffer(opts: { incomplete?: boolean } = {}): string {
  return [
    "←  ☐ Toppings  ✔ Submit  →",
    "",
    "Review your answers",
    ...(opts.incomplete ? ["", "⚠ You have not answered all questions"] : []),
    "",
    "Ready to submit your answers?",
    "",
    "❯ 1. Submit answers",
    "  2. Cancel",
  ].join("\n");
}

function model(text: string): MultiSelectModel {
  const m = detectMultiSelect(splitLines(parseAnsi(text)));
  if (!m) throw new Error("synthetic buffer did not detect a multi-select dialog");
  return m;
}

function paneWith(text: string, revision = 5) {
  return { paneId: "w1:p1", text, truncated: false, revision };
}

// Serve a SCRIPT of pane states: each fetch consumes one entry; the last repeats forever.
function script(...texts: string[]) {
  const queue = [...texts];
  mockFetchPane.mockImplementation(async () =>
    paneWith(queue.length > 1 ? queue.shift()! : queue[0]!),
  );
}

const noSleep = async () => {};
const base = {
  paneId: "w1:p1",
  requestedLines: 600,
  detectedRevision: 5,
  // The guard re-derives through the pane's ADAPTER (lib/dialog-guard.ts), so every call names the
  // agent whose grammar produced the fixture — an agent with no adapter fails the guard closed.
  agent: "claude",
  sleep: noSleep,
};
const keysSent = () => mockSendKeys.mock.calls.map((c) => c[1]);

beforeEach(() => {
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
});

describe("multiSelectEquals / multiSelectIdentity", () => {
  it("equals: full state incl. checked; unequal across question / checked; ignores pointer", () => {
    const a = model(checkboxBuffer({ pointer: "opt1", checked: [] }));
    // Pointer moved but everything else identical → still the same visible state (pointer is transient).
    expect(multiSelectEquals(a, model(checkboxBuffer({ pointer: "chat", checked: [] })))).toBe(true);
    // A checkbox flip IS a visible-state change the entry guard must catch.
    expect(multiSelectEquals(a, model(checkboxBuffer({ checked: [2] })))).toBe(false);
    // A different question is a different dialog.
    expect(multiSelectEquals(a, model(checkboxBuffer({ question: "Something else?" })))).toBe(false);
  });

  it("identity: pointer-independent but checked-DEPENDENT (an external mid-walk flip is drift)", () => {
    const a = model(checkboxBuffer({ pointer: "opt1", checked: [] }));
    // The macro's own pointer move (it only ever sends Down/Up — never a toggle) is NOT drift.
    expect(multiSelectIdentity(a, model(checkboxBuffer({ pointer: "submit", checked: [] })))).toBe(true);
    // But a box that flipped underfoot (a second device toggled it) IS — we must not walk on and
    // ship a set the user never saw.
    expect(multiSelectIdentity(a, model(checkboxBuffer({ pointer: "submit", checked: [3] })))).toBe(false);
    // A different question / different labels is a different dialog (the identity re-derivation guard).
    expect(multiSelectIdentity(a, model(checkboxBuffer({ question: "Another question?" })))).toBe(false);
  });
});

describe("toggle / escape — one guarded keystroke", () => {
  it("toggle sends the option's digit alone", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "opt1" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 3 } });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["3"], m.regionSignature],
    ]);
  });

  it("escape sends the 'Chat about this' digit", async () => {
    const m = model(checkboxBuffer({}));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({})));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "escape" } });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["6"], m.regionSignature],
    ]);
  });

  it("returns changed when the bound key write reports prompt_changed", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    mockFetchPane.mockResolvedValueOnce(paneWith(checkboxBuffer({ pointer: "opt1" })));
    mockSendKeys.mockResolvedValueOnce({
      ok: false,
      error: "Prompt changed before keys were sent",
      code: "prompt_changed",
    });
    const res = await submitMultiSelectIntent({
      ...base,
      multi: m,
      intent: { kind: "toggle", n: 3 },
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["3"], m.regionSignature],
    ]);
  });

  it("toggle rejects an out-of-range digit against the model, sending nothing (no stray keystroke)", async () => {
    const m = model(checkboxBuffer({})); // options 1..4
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({})));
    // n=7 is not a real option row — the renderer must never inject a digit the model doesn't back.
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 7 } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
    // The escape digit (6) is NOT a toggle target either — a toggle must match an OPTION, not the escape.
    const res2 = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 6 } });
    expect(res2).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("toggle rejects at the entry guard when the dialog changed underfoot (no keys)", async () => {
    const m = model(checkboxBuffer({ checked: [] }));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ checked: [1] }))); // a box flipped
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 2 } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("toggle rejects when the fresh revision differs (frozen mirror, advanced pane)", async () => {
    const m = model(checkboxBuffer({}));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({}), 9));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 1 } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});

describe("review — confirm / cancel", () => {
  it("confirm sends digit 1; cancel sends digit 2", async () => {
    const m = model(reviewBuffer({ incomplete: true }));
    mockFetchPane.mockResolvedValue(paneWith(reviewBuffer({ incomplete: true })));
    expect(await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "confirm" } })).toEqual({
      status: "sent",
    });
    expect(await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "cancel" } })).toEqual({
      status: "sent",
    });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["1"], m.regionSignature],
      ["w1:p1", ["2"], m.regionSignature],
    ]);
  });
});

describe("submit macro — walk the pointer down onto Submit, then Enter", () => {
  it("walks Down until a fresh read shows the pointer on Submit, then Enters", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    script(
      checkboxBuffer({ pointer: "opt1" }), // entry guard
      checkboxBuffer({ pointer: "opt1" }), // read: an option row → Down
      checkboxBuffer({ pointer: "opt2" }), // read: still an option row → Down
      checkboxBuffer({ pointer: "submit" }), // read: on Submit → Enter (stops here, no overshoot)
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Down"], m.regionSignature],
      ["w1:p1", ["Down"]],
      ["w1:p1", ["Enter"]],
    ]);
  });

  it("returns changed when the first bound macro write reports prompt_changed", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    script(
      checkboxBuffer({ pointer: "opt1" }), // entry guard
      checkboxBuffer({ pointer: "opt1" }), // first pointer read leads to Down
    );
    mockSendKeys.mockResolvedValueOnce({
      ok: false,
      error: "Prompt changed before keys were sent",
      code: "prompt_changed",
    });
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Down"], m.regionSignature],
    ]);
  });

  it("re-sends Down when a key is swallowed (the re-read still shows an option row)", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    script(
      checkboxBuffer({ pointer: "opt1" }), // entry guard
      checkboxBuffer({ pointer: "opt2" }), // read: option → Down
      checkboxBuffer({ pointer: "opt2" }), // read: STILL option (Down swallowed) → Down again
      checkboxBuffer({ pointer: "submit" }), // read: Submit → Enter
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Down"], ["Down"], ["Enter"]]);
  });

  it("Ups onto Submit when the pointer starts on the bottom Chat row (Submit is one row above)", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    script(
      checkboxBuffer({ pointer: "opt1" }), // entry guard
      checkboxBuffer({ pointer: "chat" }), // read: on the bottom row → Up
      checkboxBuffer({ pointer: "submit" }), // read: Submit → Enter
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Up"], ["Enter"]]);
  });

  it("NEVER Enters when the pointer never reaches Submit within the bounded walk", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    // Every read shows an option row — the pointer never converges on Submit, so the bounded walk
    // exhausts and refreshes rather than blind-sending an Enter at an unverified row.
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "opt2" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).not.toContainEqual(["Enter"]);
    expect(keysSent().every((k) => k[0] === "Down")).toBe(true); // only ever nudged downward
  });

  it("NEVER Enters when the pointer sits on the free-text row — nudges past it, never activates", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    // The ❯ parked on "5. [ ] Type something" (the composer row) reads as a non-Submit row, so the
    // walk only ever nudges Down — it must never mistake it for Submit and blind-Enter.
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "free" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).not.toContainEqual(["Enter"]);
    expect(keysSent().every((k) => k[0] === "Down")).toBe(true);
  });

  it("NEVER Enters when NO row carries the pointer (pointer null throughout)", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    // A redraw with the ❯ absent → pointer null → still not Submit, so the walk nudges Down and never
    // blind-Enters at an unverified row.
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "none" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).not.toContainEqual(["Enter"]);
    expect(keysSent().every((k) => k[0] === "Down")).toBe(true);
  });

  it("aborts (no Enter) when a different dialog drifts in mid-walk", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    script(
      checkboxBuffer({ pointer: "opt1" }), // entry guard: same dialog
      checkboxBuffer({ pointer: "opt1" }), // read: option → Down
      // A DIFFERENT dialog (new question), even with the pointer on Submit — the per-read identity
      // check must reject it so NO Enter follows.
      checkboxBuffer({ pointer: "submit", question: "A different question?" }),
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).toEqual([["Down"]]); // drift detected on the read, before any further key
    expect(keysSent()).not.toContainEqual(["Enter"]);
  });

  it("rejects at the entry guard (no keys at all) when the dialog already changed", async () => {
    const m = model(checkboxBuffer({ checked: [] }));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ question: "Different?" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});

describe("grok tab-space-enter checkbox recipe", () => {
  const PANES = join(import.meta.dirname, "..", "fixtures", "panes");
  const grokBase = { ...base, agent: "grok" as const };

  function grokAnsi(name: string): string {
    return readFileSync(join(PANES, name), "utf8");
  }

  function grokModel(ansi: string): MultiSelectModel {
    const block = grokAdapter.buildBlocks(splitLines(parseAnsi(ansi))).find((b) => b.kind === "multi-select");
    if (block?.kind !== "multi-select") throw new Error("expected grok multi-select");
    return block.multi;
  }

  function moveFocus(ansi: string, toNeedle: string): string {
    const rows = ansi.split("\n");
    const src = rows.findIndex((l) => l.includes("54;54;54") && l.includes("[ ]"));
    const dst = rows.findIndex((l, i) => i > src && l.includes(toNeedle) && l.includes("[ ]"));
    if (src < 0 || dst < 0) throw new Error(`focus rows ${src} ${dst}`);
    rows[src] = rows[src]!.replaceAll("48;2;54;54;54", "48;2;36;36;36");
    rows[dst] = rows[dst]!.replace("48;2;36;36;36m[ ]", "48;2;54;54;54m[ ]");
    return rows.join("\n");
  }

  it("toggle of the focused row sends Space, never a digit", async () => {
    const ansi = grokAnsi("grok--ask-multi.txt");
    const m = grokModel(ansi);
    mockFetchPane.mockResolvedValue(paneWith(ansi));
    const res = await submitMultiSelectIntent({ ...grokBase, multi: m, intent: { kind: "toggle", n: 1 } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Space"]]);
  });

  it("toggle of a later row Tabs onto it then Space — never the digit", async () => {
    const start = grokAnsi("grok--ask-multi.txt");
    const focused2 = moveFocus(start, "Pepperoni");
    const m = grokModel(start);
    script(start, start, focused2);
    const res = await submitMultiSelectIntent({ ...grokBase, multi: m, intent: { kind: "toggle", n: 2 } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Tab"], ["Space"]]);
  });

  it("advance sends Enter, not the Claude Down/Up walk", async () => {
    const ansi = grokAnsi("grok--ask-multi.txt");
    const m = grokModel(ansi);
    mockFetchPane.mockResolvedValue(paneWith(ansi));
    const res = await submitMultiSelectIntent({ ...grokBase, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Enter"]]);
  });

  function parkFooter(ansi: string): string {
    if (!ansi.includes(":next answer")) throw new Error("live ask footer missing");
    return ansi.replace(":next answer", "/Space:question");
  }

  it("parked toggle Tabs to re-enter, then Space on the focused row — never a digit", async () => {
    const parked = parkFooter(grokAnsi("grok--ask-multi.txt"));
    const live = grokAnsi("grok--ask-multi.txt");
    const m = grokModel(parked);
    expect(m.phase === "checkbox" && m.parked).toBe(true);
    script(parked, live);
    const res = await submitMultiSelectIntent({ ...grokBase, multi: m, intent: { kind: "toggle", n: 1 } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Tab"], ["Space"]]);
  });

  it("parked toggle of a later row unparks, Tabs onto it, then Space", async () => {
    const parked = parkFooter(grokAnsi("grok--ask-multi.txt"));
    const live = grokAnsi("grok--ask-multi.txt");
    const focused2 = moveFocus(live, "Pepperoni");
    const m = grokModel(parked);
    script(parked, live, focused2);
    const res = await submitMultiSelectIntent({ ...grokBase, multi: m, intent: { kind: "toggle", n: 2 } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Tab"], ["Tab"], ["Space"]]);
  });

  it("parked advance sends Tab then Enter", async () => {
    const parked = parkFooter(grokAnsi("grok--ask-multi.txt"));
    const m = grokModel(parked);
    mockFetchPane.mockResolvedValue(paneWith(parked));
    const res = await submitMultiSelectIntent({ ...grokBase, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Tab", "Enter"]]);
  });
});

describe("per-pane serialization — overlapping actions can't both fire", () => {
  it("a second Submit while one is in-flight on the same pane is rejected, and only ONE Enters", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    // Park the FIRST macro's entry read so it stays in-flight while we fire the second on the same pane.
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    mockFetchPane.mockImplementation(async () => {
      if (call++ === 0) await firstRead; // hold the first entry read open
      return paneWith(checkboxBuffer({ pointer: "submit" }));
    });

    const first = submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    // The second tap lands while the first is parked mid-flight → rejected before any read/send.
    const second = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(second).toEqual({ status: "changed" });

    releaseFirst();
    expect(await first).toEqual({ status: "sent" });
    // Exactly ONE Enter ever reached the terminal — the second macro never ran (no auto-confirm past
    // the review screen).
    expect(keysSent().filter((k) => k[0] === "Enter")).toHaveLength(1);
  });

  it("releases the lock after completion — a later action on the same pane proceeds normally", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "opt1" })));
    expect(
      await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 2 } }),
    ).toEqual({ status: "sent" });
    // The lock cleared, so the next action on the same pane is NOT blocked by a stale entry.
    expect(
      await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 3 } }),
    ).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["2"], ["3"]]);
  });
});

// The `signature` normalises ☒/☑ → ☐ across the whole chip line, because the current question's chip
// flips on the first tick. That also erases WHICH step you are on — so the comparators have to carry
// the steps themselves, or a tap meant for one question lands on another.
describe("multiSelectEquals / multiSelectIdentity — wizard step identity", () => {
  const step = (
    chips: { label: string; answered: boolean; current: boolean }[],
  ): MultiSelectModel => ({
    phase: "checkbox",
    question: "Which changes should I keep?",
    options: [
      { n: 1, label: "Formatting", checked: false },
      { n: 2, label: "Renames", checked: false },
    ],
    escape: { n: 3, label: "Chat about this" },
    pointer: "option",
    steps: chips,
    advanceLabel: "Next",
    // Deliberately IDENTICAL: this is what the normalisation leaves behind for two steps of one
    // wizard whose questions and options happen to read the same.
    signature: "same",
    regionSignature: "region",
  });

  const q1 = step([
    { label: "Backend", answered: false, current: true },
    { label: "Frontend", answered: false, current: false },
  ]);
  const q2 = step([
    { label: "Backend", answered: true, current: false },
    { label: "Frontend", answered: false, current: true },
  ]);

  it("does not treat two steps of one wizard as the same screen", () => {
    expect(multiSelectEquals(q1, q2)).toBe(false);
    expect(multiSelectIdentity(q1, q2)).toBe(false);
  });

  it("still treats the same step as itself", () => {
    expect(multiSelectEquals(q1, step(q1.phase === "checkbox" ? q1.steps! : []))).toBe(true);
    expect(multiSelectIdentity(q1, step(q1.phase === "checkbox" ? q1.steps! : []))).toBe(true);
  });

  it("separates a Next step from the Submit step even if everything else matches", () => {
    const onSubmit = { ...q1, advanceLabel: "Submit" } as MultiSelectModel;
    expect(multiSelectEquals(q1, onSubmit)).toBe(false);
  });
});
});

describe("merged preview-action.test.ts", () => {

// The preview-dialog choreography engine: entry guard + the multi-step recipes (digit→verify→Enter
// for options, n→verify→clear→type→Escape for notes; grammar/NOTES_NOTES.md). The api layer is
// mocked so the mid-flight pane states can be sequenced precisely; the detector is the real thing,
// driven by synthetic plain-text buffers (styling only matters for the wizard stepper's current
// chip, which these single-question buffers don't carry).


const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);
const mockSendReply = vi.mocked(sendReply);

// A synthetic preview dialog in the exact live layout (fixtures claude--select-preview*.txt):
// fixed-width label column, preview pane + Notes line sharing a column, rule, escape row, footer.
// `labels`/`pane` override the left-column subject / right-hand preview; `subject` prepends a context
// line ABOVE the dialog (captured by the core-signature lookback but not parsed into question/labels).
function buffer(opts: {
  pointer?: number;
  note?: string;
  editing?: boolean;
  question?: string;
  labels?: string[];
  pane?: string[];
  subject?: string;
}) {
  const pointer = opts.pointer ?? 1;
  const labels = opts.labels ?? ["Boxy", "Rounded", "Minimal"];
  const pane = opts.pane ?? ["┌─────────┐", "│ MOCKUP  │", "└─────────┘"];
  const col = 34;
  const rows = labels.map((label, i) => {
    const left = `${pointer === i + 1 ? "❯" : " "} ${i + 1}. ${label}`;
    return left.padEnd(col) + (pane[i] ?? "");
  });
  const noteText = opts.editing
    ? (opts.note ?? "") || "Add notes on this design…"
    : (opts.note ?? "") || "press n to add notes";
  const footer =
    "Enter to select · ↑/↓ to navigate · n to add notes" +
    (opts.editing ? " · ctrl+g to edit in nano" : "") +
    " · Esc to cancel";
  return [
    ...(opts.subject ? [opts.subject] : []),
    " ☐ Design",
    "",
    opts.question ?? "Which widget design should we use?",
    "",
    ...rows,
    "",
    " ".repeat(col) + `Notes: ${noteText}`,
    "",
    "─".repeat(60),
    "  Chat about this",
    "",
    footer,
  ].join("\n");
}

function model(opts: Parameters<typeof buffer>[0]) {
  const m = detectPreviewSelect(splitLines(parseAnsi(buffer(opts))));
  if (!m) throw new Error("synthetic buffer did not detect");
  return m;
}

function paneWith(text: string, revision = 5) {
  return { paneId: "w1:p1", text, truncated: false, revision };
}

const noSleep = async () => {};
const base = {
  paneId: "w1:p1",
  requestedLines: 600,
  detectedRevision: 5,
  // The guard re-derives through the pane's ADAPTER (lib/dialog-guard.ts), so every call names the
  // agent whose grammar produced the fixture — an agent with no adapter fails the guard closed.
  agent: "claude",
  sleep: noSleep,
};

beforeEach(() => {
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendReply.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
  mockSendReply.mockResolvedValue({ ok: true });
});

describe("previewsEqual", () => {
  it("equal for the same buffer; unequal across pointer, note, and question changes", () => {
    expect(previewsEqual(model({}), model({}))).toBe(true);
    // A pointer move re-routes what Enter would select — it must invalidate a tap.
    expect(previewsEqual(model({}), model({ pointer: 2 }))).toBe(false);
    // A note appearing/changing is a visible state change.
    expect(previewsEqual(model({}), model({ note: "hi" }))).toBe(false);
    expect(previewsEqual(model({ note: "a" }), model({ note: "b" }))).toBe(false);
    // The TUI input opening flips the note state even with no text yet.
    expect(previewsEqual(model({}), model({ editing: true }))).toBe(false);
    expect(previewsEqual(model({}), model({ question: "Something else?" }))).toBe(false);
  });

  it("rejects a pane-only difference (the preview pane re-routes what the pointed row means)", () => {
    // Same options, pointer, and note — only the right-hand preview pane content differs. The
    // pane comparison must catch it (the core signature deliberately excludes the pane).
    expect(previewsEqual(model({}), model({ pane: ["┌X┐", "│Y│", "└Z┘"] }))).toBe(false);
  });

  it("rejects a same-shaped successor: identical question/labels/pointer/note, different subject", () => {
    // The dangerous case H-1 closes: two dialogs that render identically but for the SUBJECT above
    // them (e.g. a different file being edited). Pre-fix this compared "equal" and a stale tap could
    // approve the wrong one; the pointer/note-independent core signature now separates them.
    expect(
      previewsEqual(model({ subject: "Editing foo.ts" }), model({ subject: "Editing bar.ts" })),
    ).toBe(false);
    // A changed option label (the left-column subject) is caught too.
    expect(previewsEqual(model({}), model({ labels: ["Boxy", "Rounded", "Compact"] }))).toBe(false);
  });
});

describe("submitPreviewOption — digit → verify pointer → Enter", () => {
  it("sends the digit, waits for the pointer to land on the row, then confirms with Enter", async () => {
    const m = model({ pointer: 1 });
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer({ pointer: 1 }))) // entry guard
      .mockResolvedValue(paneWith(buffer({ pointer: 2 }))); // verification poll
    const res = await submitPreviewOption({ ...base, preview: m, option: m.options[1]! });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["2"], m.regionSignature],
      ["w1:p1", ["Enter"]],
    ]);
  });

  it("returns changed when the bound digit write reports prompt_changed", async () => {
    const m = model({ pointer: 1 });
    mockFetchPane.mockResolvedValueOnce(paneWith(buffer({ pointer: 1 })));
    mockSendKeys.mockResolvedValueOnce({
      ok: false,
      error: "Prompt changed before keys were sent",
      code: "prompt_changed",
    });
    const res = await submitPreviewOption({ ...base, preview: m, option: m.options[1]! });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["2"], m.regionSignature],
    ]);
  });

  it("never sends Enter when the pointer does not converge (digit was the only side effect)", async () => {
    const m = model({ pointer: 1 });
    mockFetchPane.mockResolvedValue(paneWith(buffer({ pointer: 1 }))); // pointer never moves
    const res = await submitPreviewOption({ ...base, preview: m, option: m.options[2]! });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["3"], m.regionSignature],
    ]);
  });

  it("rejects at the entry guard when the dialog changed underfoot (no keys at all)", async () => {
    const m = model({});
    mockFetchPane.mockResolvedValue(paneWith(buffer({ question: "Different question?" })));
    const res = await submitPreviewOption({ ...base, preview: m, option: m.options[0]! });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("rejects when the fresh revision differs (frozen mirror, advanced pane)", async () => {
    const m = model({});
    mockFetchPane.mockResolvedValue(paneWith(buffer({}), 9));
    const res = await submitPreviewOption({ ...base, preview: m, option: m.options[0]! });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("aborts the verification poll early when the dialog's identity drifts mid-flight", async () => {
    const m = model({ pointer: 1 });
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer({ pointer: 1 })))
      .mockResolvedValue(paneWith(buffer({ question: "Another dialog entirely?" })));
    const res = await submitPreviewOption({ ...base, preview: m, option: m.options[1]! });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["2"], m.regionSignature],
    ]); // digit only, no Enter
  });

  it("rejects a same-labels successor whose core signature differs mid-flight — NO Enter", async () => {
    // The H-1 mid-flight hazard: after the digit is sent, a successor with the SAME question+labels
    // but a different subject renders — with the pointer already on the tapped row. Pre-fix, the
    // acceptance check keyed on question+labels only, so structureEqual passed and the unconditional
    // Enter submitted the WRONG dialog's row. The core signature now differs → the poll drifts → the
    // digit's pointer move stays the only side effect.
    const m = model({ pointer: 1, subject: "Editing foo.ts" });
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer({ pointer: 1, subject: "Editing foo.ts" }))) // entry guard: same dialog
      .mockResolvedValue(paneWith(buffer({ pointer: 2, subject: "Editing bar.ts" }))); // successor: pointer on tapped row, DIFFERENT subject
    const res = await submitPreviewOption({ ...base, preview: m, option: m.options[1]! });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["2"], m.regionSignature],
    ]); // digit moved the pointer; Enter never fired
  });
});

describe("submitPreviewNote — n → verify focus → clear → type → Escape (never Enter)", () => {
  // Every stage of the choreography is verified against a fresh read before the next fires, so the
  // mock serves a SCRIPT of pane states: each fetch consumes one entry, the last repeats.
  function script(...texts: string[]) {
    const queue = [...texts];
    mockFetchPane.mockImplementation(async () =>
      paneWith(queue.length > 1 ? queue.shift()! : queue[0]!),
    );
  }

  it("adds a fresh note: n, focus poll, reply-typed text (verified), Escape (verified) — no clear", async () => {
    const m = model({});
    script(
      buffer({}), // entry guard
      buffer({ editing: true }), // input focused
      buffer({ editing: true, note: "focus on mobile" }), // text rendered
      buffer({ note: "focus on mobile" }), // blurred: note attached
    );
    const res = await submitPreviewNote({ ...base, preview: m, text: "focus on mobile" });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["n"], m.regionSignature],
      ["w1:p1", ["Escape"]],
    ]);
    expect(mockSendReply.mock.calls).toEqual([["w1:p1", "focus on mobile", false]]);
  });

  it("returns changed when the bound note-open write reports prompt_changed", async () => {
    const m = model({});
    mockFetchPane.mockResolvedValueOnce(paneWith(buffer({})));
    mockSendKeys.mockResolvedValueOnce({
      ok: false,
      error: "Prompt changed before keys were sent",
      code: "prompt_changed",
    });
    const res = await submitPreviewNote({ ...base, preview: m, text: "focus on mobile" });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["n"], m.regionSignature],
    ]);
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("replaces an existing note with the deterministic clear (ctrl+k + Backspace sweep)", async () => {
    const m = model({ note: "old note" });
    script(
      buffer({ note: "old note" }), // entry guard
      buffer({ note: "old note", editing: true }), // input focused (old text intact)
      buffer({ editing: true }), // cleared: empty input
      buffer({ editing: true, note: "new note" }), // new text rendered
      buffer({ note: "new note" }), // blurred: replaced
    );
    const res = await submitPreviewNote({ ...base, preview: m, text: "new note" });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls[0]).toEqual([
      "w1:p1",
      ["n"],
            m.regionSignature,
    ]);
    const clear = mockSendKeys.mock.calls[1]![1];
    expect(clear[0]).toBe("ctrl+k");
    expect(clear.length).toBe(1 + NOTE_MAX_LENGTH + 20);
    expect(clear.slice(1).every((k: string) => k === "Backspace")).toBe(true);
    expect(mockSendKeys.mock.calls[1]).toHaveLength(2);
    expect(mockSendKeys.mock.calls[2]).toEqual(["w1:p1", ["Escape"]]);
    expect(mockSendReply.mock.calls).toEqual([["w1:p1", "new note", false]]);
  });

  it("removes a note with empty text: clear + Escape, nothing typed", async () => {
    const m = model({ note: "old note" });
    script(
      buffer({ note: "old note" }),
      buffer({ note: "old note", editing: true }),
      buffer({ editing: true }), // cleared
      buffer({}), // blurred: hint line back, note gone
    );
    const res = await submitPreviewNote({ ...base, preview: m, text: "" });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendReply).not.toHaveBeenCalled();
    expect(mockSendKeys.mock.calls.map((c) => c[1][0])).toEqual(["n", "ctrl+k", "Escape"]);
  });

  it("collapses whitespace/newlines and caps the typed text", async () => {
    const raw = "  a\nb\t c  " + "x".repeat(400);
    const expected = raw.replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim().slice(0, NOTE_MAX_LENGTH);
    const m = model({});
    script(
      buffer({}),
      buffer({ editing: true }),
      buffer({ editing: true, note: expected }),
      buffer({ note: expected }),
    );
    const res = await submitPreviewNote({ ...base, preview: m, text: raw });
    expect(res).toEqual({ status: "sent" });
    const typed = mockSendReply.mock.calls[0]![1] as string;
    expect(typed).toBe(expected);
    expect(typed.startsWith("a b c x")).toBe(true);
    expect(typed).not.toMatch(/[\n\t]/);
    expect(typed.length).toBe(NOTE_MAX_LENGTH);
  });

  it("strips C0 control chars (ESC/BEL/ETX) from the pasted note before it reaches the input", async () => {
    // Pasted clipboard text can smuggle in raw control bytes — ESC blurs/cancels the dialog, BEL
    // opens the external editor — which the reply path would deliver into the FOCUSED input before
    // any readback. They must be gone from what we send.
    const raw = "safe\x1b[31m\x07 note\x03 here";
    const expected = raw.replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim().slice(0, NOTE_MAX_LENGTH);
    const m = model({});
    script(
      buffer({}),
      buffer({ editing: true }),
      buffer({ editing: true, note: expected }),
      buffer({ note: expected }),
    );
    const res = await submitPreviewNote({ ...base, preview: m, text: raw });
    expect(res).toEqual({ status: "sent" });
    const typed = mockSendReply.mock.calls[0]![1] as string;
    expect(typed).toBe(expected);
    expect(typed).not.toMatch(/\p{Cc}/u); // no raw control byte survives
    expect(typed).toContain("safe");
    expect(typed).toContain("note");
  });

  it("retries a swallowed Escape once (the blur is verified, not assumed)", async () => {
    const m = model({});
    script(
      buffer({}), // entry guard
      buffer({ editing: true }), // focused
      buffer({ editing: true, note: "hi" }), // text rendered — but then the input STAYS focused
      ...Array.from({ length: 8 }, () => buffer({ editing: true, note: "hi" })), // 1st blur poll times out
      buffer({ note: "hi" }), // 2nd Escape lands
    );
    const res = await submitPreviewNote({ ...base, preview: m, text: "hi" });
    expect(res).toEqual({ status: "sent" });
    const escapes = mockSendKeys.mock.calls.filter((c) => c[1][0] === "Escape");
    expect(escapes).toHaveLength(2);
  });

  it("aborts the blur with NO second Escape when a successor dialog drifts in after the first", async () => {
    // H-2: after the note lands and the first Escape is sent, a same-shaped SUCCESSOR (different
    // subject) is on screen. The old collapse of drift/timeout would resend Escape — cancelling that
    // successor. pollUntil now returns "drifted", so the flow aborts with "changed" and one Escape.
    const m = model({ subject: "Editing foo.ts" });
    script(
      buffer({ subject: "Editing foo.ts" }), // entry guard
      buffer({ subject: "Editing foo.ts", editing: true }), // focused
      buffer({ subject: "Editing foo.ts", editing: true, note: "hi" }), // text rendered
      buffer({ subject: "Editing bar.ts", editing: true, note: "hi" }), // after 1st Escape: a successor
    );
    const res = await submitPreviewNote({ ...base, preview: m, text: "hi" });
    expect(res).toEqual({ status: "changed" });
    const escapes = mockSendKeys.mock.calls.filter((c) => c[1][0] === "Escape");
    expect(escapes).toHaveLength(1);
  });

  it("aborts the blur with NO second Escape when the dialog vanishes after the first (agent running)", async () => {
    // The other H-2 half: the dialog is gone (model re-derives to null on every read — the agent is
    // running again). A blind second Escape would interrupt it. pollUntil's all-null poll ⇒ "drifted".
    const m = model({});
    script(
      buffer({}), // entry guard
      buffer({ editing: true }), // focused
      buffer({ editing: true, note: "hi" }), // text rendered
      "● Running now\n  ⎿  working…\n", // dialog gone
    );
    const res = await submitPreviewNote({ ...base, preview: m, text: "hi" });
    expect(res).toEqual({ status: "changed" });
    const escapes = mockSendKeys.mock.calls.filter((c) => c[1][0] === "Escape");
    expect(escapes).toHaveLength(1);
  });

  it("refuses while the TUI's note input is already focused (keys would corrupt it)", async () => {
    const m = model({ editing: true });
    const res = await submitPreviewNote({ ...base, preview: m, text: "hello" });
    expect(res).toEqual({ status: "changed" });
    expect(mockFetchPane).not.toHaveBeenCalled();
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("stops dead (no blind Escape) when the input never opens", async () => {
    const m = model({});
    mockFetchPane.mockResolvedValue(paneWith(buffer({}))); // editing state never appears
    const res = await submitPreviewNote({ ...base, preview: m, text: "hello" });
    expect(res).toEqual({ status: "error", error: "Note input didn't open — check the pane" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["n"], m.regionSignature],
    ]);
    expect(mockSendReply).not.toHaveBeenCalled();
  });
});

describe("submitPreviewKeys — guarded single keystroke (wizard step navigation)", () => {
  it("sends the keys when the fresh buffer still shows the same dialog", async () => {
    const m = model({});
    mockFetchPane.mockResolvedValue(paneWith(buffer({})));
    const res = await submitPreviewKeys({ ...base, preview: m, keys: ["Right"] });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith(
      "w1:p1",
      ["Right"],
            m.regionSignature,
    );
  });

  it("returns changed when the bound navigation write reports prompt_changed", async () => {
    const m = model({});
    mockFetchPane.mockResolvedValueOnce(paneWith(buffer({})));
    mockSendKeys.mockResolvedValueOnce({
      ok: false,
      error: "Prompt changed before keys were sent",
      code: "prompt_changed",
    });
    const res = await submitPreviewKeys({ ...base, preview: m, keys: ["Right"] });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Right"], m.regionSignature],
    ]);
  });

  it("rejects when the dialog is gone", async () => {
    const m = model({});
    mockFetchPane.mockResolvedValue(paneWith("● Wrote the file\n  ⎿  done\n"));
    const res = await submitPreviewKeys({ ...base, preview: m, keys: ["Left"] });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});
});

describe("merged prompt-action.test.ts", () => {

// The plan dialog's FEEDBACK choreography (collie#95): the input row's digit → verify the field
// focused → type → verify our own words are in the box → Enter, which denies the plan and hands the
// agent the text. The api layer is mocked so the mid-flight pane states can be sequenced precisely;
// the detector is the real thing, driven by synthetic buffers in the live layout.
//
// What these tests are really pinning is the ORDER and the STOPPING POINTS. Enter here is
// irreversible — it rejects a plan and puts words in the agent's mouth — so it must be the last
// thing sent and it must never go out on anything but a fresh read showing our text. Every failure
// path below asserts what was NOT sent, which is the half that matters.


const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);
const mockSendReply = vi.mocked(sendReply);

// A synthetic plan-approval dialog in the live layout (fixtures claude--plan-approval*.txt): the
// subject above, the question, the answer rows, then the input row with its static hint sub-line and
// the plan footer. `focused` puts `❯` on the input row; `text` fills its box (which replaces the
// placeholder — that IS the on-screen behaviour, see PLAN_FEEDBACK_NOTES.md).
function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > width) {
      out.push(line);
      line = word;
    } else line = line ? line + " " + word : word;
  }
  if (line) out.push(line);
  return out;
}

function buffer(
  opts: {
    focused?: boolean;
    text?: string;
    subject?: string;
    noInput?: boolean;
    wrapAt?: number;
  } = {},
) {
  const rows = ["Yes, and use auto mode", "Yes, manually approve edits"];
  const input = opts.text ? opts.text : "Tell Claude what to change";
  // A value longer than the row re-flows onto continuation lines that sit ABOVE the hint — the live
  // shape (fixture claude--plan-approval--feedback-wrapped.txt). `wrapAt` splits on word boundaries
  // the way the terminal does.
  const [head, ...rest] = opts.wrapAt ? wrapWords(input, opts.wrapAt) : [input];
  const inputRows = opts.noInput
    ? []
    : [
        `   ${opts.focused ? "❯" : " "} 3. ${head}`,
        ...rest.map((line) => `        ${line}`),
        "        shift+tab to approve with this feedback",
      ];
  return [
    opts.subject ?? " Here is Claude's plan: refactor validate()",
    "",
    " Claude has written up a plan and is ready to execute. Would you like to proceed?",
    "",
    ...rows.map((label, i) => `   ${opts.focused ? " " : i === 0 ? "❯" : " "} ${i + 1}. ${label}`),
    ...inputRows,
    "",
    " ctrl+g to edit in nano · ~/.claude/plans/refactor-validate.md",
  ].join("\n");
}

function model(opts: Parameters<typeof buffer>[0] = {}) {
  const m = detectPromptSelect(splitLines(parseAnsi(buffer(opts))));
  if (!m) throw new Error("synthetic buffer did not detect");
  return m;
}

const paneWith = (text: string, revision = 5) => ({
  paneId: "w1:p1",
  text,
  truncated: false,
  revision,
});

const noSleep = async () => {};
const base = {
  paneId: "w1:p1",
  requestedLines: 600,
  detectedRevision: 5,
  // The guard re-derives through the pane's ADAPTER (lib/dialog-guard.ts), so every call names the
  // agent whose grammar produced the buffer — an agent with no adapter fails the guard closed.
  agent: "claude",
  sleep: noSleep,
};

beforeEach(() => {
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendReply.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
  mockSendReply.mockResolvedValue({ ok: true });
});

describe("the synthetic buffer matches the live grammar", () => {
  it("detects the input row in each of its states, and never as an option", () => {
    expect(model().feedback).toEqual({ key: "3", focused: false, text: "" });
    expect(model({ focused: true }).feedback).toEqual({ key: "3", focused: true, text: "" });
    expect(model({ text: "use a switch" }).feedback).toEqual({
      key: "3",
      focused: false,
      text: "use a switch",
    });
    expect(model().options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
  });
});

describe("submitPromptFeedback — digit → verify focus → type → verify text → Enter", () => {
  it("runs the sequence in order and submits only after the text is on screen", async () => {
    const m = model();
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer())) // entry guard: the dialog the user saw
      .mockResolvedValueOnce(paneWith(buffer({ focused: true }))) // focus poll
      .mockResolvedValue(paneWith(buffer({ focused: true, text: "use a switch instead" }))); // text poll

    const res = await submitPromptFeedback({ ...base, prompt: m, text: "use a switch instead" });

    expect(res).toEqual({ status: "sent" });
    // BOTH writes are bound, each to the region of the screen it is actually aimed at: the digit to
    // the entry guard's, the Enter to a re-read taken after the text landed. The Enter is the only
    // irreversible key in the flow, so it must not be the one that goes out unbound.
    const filled = detectPromptSelect(
      splitLines(parseAnsi(buffer({ focused: true, text: "use a switch instead" }))),
    )!;
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["3"], m.signature],
      ["w1:p1", ["Enter"], filled.signature],
    ]);
    // Typed unsubmitted, through the reply path — one paste, immune to the per-key focus race.
    expect(mockSendReply.mock.calls).toEqual([["w1:p1", "use a switch instead", false]]);
  });

  it("reads back a value the row WRAPPED across lines, rejoined and matched exactly", async () => {
    // The row does not window a long value around the caret — it re-flows the whole thing across as
    // many lines as it needs (measured live). The grammar rejoins them, so the evidence for the Enter
    // is the FULL text, matched exactly; there is no reason to accept a partial match for the one
    // irreversible key in the flow.
    const text = "please use a switch statement rather than the guard clauses you proposed here";
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValueOnce(paneWith(buffer({ focused: true })))
      .mockResolvedValue(paneWith(buffer({ focused: true, text, wrapAt: 30 })));
    expect(await submitPromptFeedback({ ...base, prompt: model(), text })).toEqual({
      status: "sent",
    });
    expect(mockSendKeys.mock.calls.at(-1)![1]).toEqual(["Enter"]);
  });

  it("refuses when the wrap seam loses a character — no partial match earns the Enter", async () => {
    const text = "please use a switch statement rather than guard clauses";
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValueOnce(paneWith(buffer({ focused: true })))
      .mockResolvedValue(paneWith(buffer({ focused: true, text: text.slice(0, -6), wrapAt: 30 })));
    const res = await submitPromptFeedback({ ...base, prompt: model(), text });
    expect(res.status).toBe("error");
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["3"]]); // no Enter
  });

  it("a wrapped value keeps the dialog readable at all — the footer gap makes room", async () => {
    // Before this was understood a 355-character value pushed the footer past MAX_FOOTER_GAP and the
    // WHOLE dialog fell to the raw mirror, taking the buttons with it.
    const long = "x y ".repeat(50).trim();
    expect(model({ text: long, wrapAt: 40 }).feedback!.text).toBe(long);
  });

  it("truncates at FEEDBACK_MAX_LENGTH and types exactly what it verifies", async () => {
    const long = "x".repeat(FEEDBACK_MAX_LENGTH + 50);
    const clipped = "x".repeat(FEEDBACK_MAX_LENGTH);
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValueOnce(paneWith(buffer({ focused: true })))
      .mockResolvedValue(paneWith(buffer({ focused: true, text: clipped })));
    expect(await submitPromptFeedback({ ...base, prompt: model(), text: long })).toEqual({
      status: "sent",
    });
    expect(mockSendReply.mock.calls[0]![1]).toBe(clipped);
  });
});

describe("submitPromptFeedback — the states it refuses BEFORE touching the pane", () => {
  it("refuses while the input already has focus (someone is typing in the terminal)", async () => {
    const res = await submitPromptFeedback({
      ...base,
      prompt: model({ focused: true }),
      text: "hi",
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockFetchPane).not.toHaveBeenCalled();
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("refuses when the box already holds text — our words would be PREPENDED to theirs", async () => {
    // Measured on 2.1.233: re-entering the field puts the caret at position 0, so typing prepends and
    // Backspace there is a no-op. There is no safe clear, so the phone does not type at all.
    const res = await submitPromptFeedback({
      ...base,
      prompt: model({ text: "half a sentence" }),
      text: "hi",
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("refuses on a dialog that has no input row at all", async () => {
    // The same dialog with its input row removed — every other prompt family (permission, trust,
    // plain select) looks like this, and the flow must be inert on all of them.
    const plain = detectPromptSelect(splitLines(parseAnsi(buffer({ noInput: true }))))!;
    expect(plain.feedback).toBeUndefined();
    expect(await submitPromptFeedback({ ...base, prompt: plain, text: "hi" })).toEqual({
      status: "changed",
    });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("refuses empty text without sending anything", async () => {
    const res = await submitPromptFeedback({ ...base, prompt: model(), text: "   " });
    expect(res.status).toBe("error");
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("stops at the entry guard when the dialog on screen is no longer the one tapped", async () => {
    mockFetchPane.mockResolvedValue(paneWith(buffer({ subject: " A different plan entirely" })));
    expect(await submitPromptFeedback({ ...base, prompt: model(), text: "hi" })).toEqual({
      status: "changed",
    });
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
  });
});

describe("submitPromptFeedback — the stopping points once it has started writing", () => {
  it("types NOTHING if focus never lands: the digit's pointer move is the only side effect", async () => {
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer())) // entry guard
      .mockResolvedValue(paneWith(buffer())); // focus never arrives
    const res = await submitPromptFeedback({ ...base, prompt: model(), text: "hi" });
    expect(res.status).toBe("error");
    expect(mockSendReply).not.toHaveBeenCalled();
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["3"], model().signature]]);
  });

  it("sends NO Enter if the text never arrives — the words wait in the box for a human", async () => {
    // The single most important assertion in this file. A blind Enter here would submit whatever the
    // box happens to hold (possibly nothing) as a plan denial.
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValue(paneWith(buffer({ focused: true }))); // focused, but the box stays empty
    const res = await submitPromptFeedback({ ...base, prompt: model(), text: "hi" });
    expect(res.status).toBe("error");
    expect(mockSendReply).toHaveBeenCalledTimes(1);
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["3"]]); // no Enter
  });

  it("aborts if the dialog DRIFTS mid-flight — a successor never gets the Enter", async () => {
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValue(paneWith(buffer({ focused: true, subject: " A different plan entirely" })));
    const res = await submitPromptFeedback({ ...base, prompt: model(), text: "hi" });
    expect(res.status).toBe("error");
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["3"]]);
  });

  it("returns changed when the bound digit write reports prompt_changed", async () => {
    mockFetchPane.mockResolvedValue(paneWith(buffer()));
    mockSendKeys.mockResolvedValueOnce({ ok: false, code: "prompt_changed", error: "moved" });
    expect(await submitPromptFeedback({ ...base, prompt: model(), text: "hi" })).toEqual({
      status: "changed",
    });
    expect(mockSendReply).not.toHaveBeenCalled();
  });
});

describe("submitPromptFeedback — the shared terminal, mid-flight", () => {
  it("types NOTHING if someone at the terminal fills the box between our digit and our paste", async () => {
    // The window this flow runs in is precisely when a human is looking at the same dialog. If they
    // start typing after our digit focused the field, their fragment sits at the HEAD — and the
    // read-back below is tail-windowed, so it cannot see a prefix. Enter would then submit their
    // words and ours as one garbled sentence. The note flow clears the field first; this row cannot
    // be cleared, so the focus poll requires it to still be EMPTY.
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer())) // entry guard
      .mockResolvedValue(paneWith(buffer({ focused: true, text: "no wait, I meant" })));
    const res = await submitPromptFeedback({ ...base, prompt: model(), text: "use a switch" });
    expect(res.status).toBe("error");
    expect(mockSendReply).not.toHaveBeenCalled();
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["3"]]); // no Enter
  });

  it("does not send the Enter if the dialog moved between the last poll and the write", async () => {
    // The re-read before the Enter is what closes the poll→write window. A dialog that drifted in it
    // aborts here rather than committing a plan denial against a screen that has moved on.
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValueOnce(paneWith(buffer({ focused: true })))
      .mockResolvedValueOnce(paneWith(buffer({ focused: true, text: "use a switch" })))
      .mockResolvedValue(paneWith(buffer({ subject: " A different plan entirely" })));
    const res = await submitPromptFeedback({ ...base, prompt: model(), text: "use a switch" });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["3"]]);
  });

  it("reports changed when the BRIDGE refuses the bound Enter (the screen moved under the write)", async () => {
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValueOnce(paneWith(buffer({ focused: true })))
      .mockResolvedValue(paneWith(buffer({ focused: true, text: "use a switch" })));
    mockSendKeys
      .mockResolvedValueOnce({ ok: true }) // the digit
      .mockResolvedValueOnce({ ok: false, code: "prompt_changed", error: "moved" }); // the Enter
    expect(await submitPromptFeedback({ ...base, prompt: model(), text: "use a switch" })).toEqual({
      status: "changed",
    });
  });
});

describe("submitPromptOption — an answer digit is refused while the input has focus", () => {
  it("sends nothing: the terminal would type the digit into the box instead of answering", async () => {
    // The bug in collie#95's §3. In this state the answer rows still parse as an ordinary menu, so the
    // model is what carries the difference — and this is the layer that actually writes, so it
    // refuses independently of whether the renderer got it right.
    const m = model({ focused: true });
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[1]! })).toEqual({
      status: "changed",
    });
    expect(mockFetchPane).not.toHaveBeenCalled();
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("still answers normally when the box holds text but the pointer is elsewhere", async () => {
    // Verified live: with `❯` off the input row the digits answer as usual, whatever is in the box.
    const m = model({ text: "half a sentence" });
    mockFetchPane.mockResolvedValue(paneWith(buffer({ text: "half a sentence" })));
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[1]! })).toEqual({
      status: "sent",
    });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["2"], m.signature]]);
  });
});
});

describe("merged reply-action.test.ts", () => {
  beforeEach(async () => {
    const real = await vi.importActual<typeof import("./api")>("./api");
    mockFetchPane.mockImplementation(real.fetchPane);
    mockSendReply.mockImplementation(real.sendReply);
  });


// The regression suite for collie#34: a free-text reply must never fire the submit key until the text is
// verifiably sitting in the harness's input box. Before this, the reply path typed and then submitted
// blind, so with a dialog focused the text was swallowed and the submit key ANSWERED the dialog —
// approving whatever option was highlighted, while the bridge still reported {ok:true}.

const BOX_RULE = "─".repeat(40); // clears the 20-glyph border threshold in harness/claude/markers
const paneWithDraft = (draft: string) => `some output\n${BOX_RULE}\n❯ ${draft}\n${BOX_RULE}`;
// A focused permission dialog: no input box at the tail at all, so extractInputDraft sees nothing.
const paneWithDialog = "Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel";

/** Record every reply POST, and let the fake pane's screen be swapped per test.
 *  After a submit POST, reads return an empty composer unless `keepDraftAfterSubmit` — a live
 *  successful send drops the draft (or the composer) and the confirm-and-rescue pass must not
 *  fire a second Enter at that screen. */
function harness(screen: () => string, opts?: { keepDraftAfterSubmit?: boolean }) {
  const calls: Array<{ text: string; submit: boolean; submit_keys?: string[] }> = [];
  server.use(
    http.get(/\/api\/pane\/[^/]+$/, () => {
      const submitted = calls.some((c) => c.submit);
      const text = submitted && !opts?.keepDraftAfterSubmit ? paneWithDraft("") : screen();
      return HttpResponse.json({ paneId: "w1:p1", text, truncated: false, revision: 1 });
    }),
    http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
      const body = (await request.json()) as { text: string; submit: boolean; submit_keys?: string[] };
      calls.push(body);
      return HttpResponse.json({ ok: true });
    }),
  );
  return calls;
}

const instant = { sleep: async () => {} }; // no real waiting; the bounded loop still runs its attempts

describe("adapter submit keys", () => {
  it("sends adapter submit keys only on the submit POST", async () => {
    const real = registry.adapterFor("claude")!;
    const spy = vi.spyOn(registry, "adapterFor").mockReturnValue({ ...real, submitKeys: ["ctrl+Enter"] });
    try {
      const calls = harness(() => paneWithDraft("hello"));
      const out = await sendGuardedReply({ paneId: "w1:p1", text: "hello", agent: "claude", ...instant });
      expect(out).toEqual({ status: "sent" });
      expect(calls).toHaveLength(2);
      expect(calls[0]).not.toHaveProperty("submit_keys");
      expect(calls[1]).toMatchObject({ submit: true, submit_keys: ["ctrl+Enter"] });
    } finally { spy.mockRestore(); }
  });

  it("omits submit keys when the adapter has no declaration", async () => {
    const real = registry.adapterFor("claude")!;
    const spy = vi.spyOn(registry, "adapterFor").mockReturnValue(real);
    try {
      const calls = harness(() => paneWithDraft("hello"));
      await sendGuardedReply({ paneId: "w1:p1", text: "hello", agent: "claude", ...instant });
      expect(calls.every((call) => !("submit_keys" in call))).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it("omits submit keys for the adapter-less one-shot path", async () => {
    const spy = vi.spyOn(registry, "adapterFor").mockReturnValue(undefined);
    try {
      const calls = harness(() => paneWithDraft("hello"));
      const out = await sendGuardedReply({ paneId: "w1:p1", text: "hello", agent: "unknown", ...instant });
      expect(out).toEqual({ status: "sent" });
      expect(calls).toEqual([{ text: "hello", submit: true }]);
    } finally { spy.mockRestore(); }
  });

  it("uses one-shot send and performs no pane fetch when the adapter declares replyOneShot (e.g. pi)", async () => {
    let fetched = false;
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => {
        fetched = true;
        return HttpResponse.json({ paneId: "w1:p1", text: "something", truncated: false, revision: 1 });
      }),
    );
    const calls = harness(() => "unused");
    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "hello from pi",
      agent: "pi",
      ...instant,
    });
    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([{ text: "hello from pi", submit: true }]);
    expect(fetched).toBe(false);
  });
});

describe("draftCarriesSend", () => {
  it("accepts the exact text, and the space-joined form of a wrapped draft", () => {
    expect(draftCarriesSend("ship it please", "ship it please")).toBe(true);
    expect(draftCarriesSend("ship it\nplease", "ship it please")).toBe(true);
  });

  it("accepts a windowed slice of a long draft", () => {
    const sent = "a much longer message than the input box can show at one time";
    expect(draftCarriesSend(sent, "message than the input box can show")).toBe(true);
  });

  it("rejects an empty, absent, or too-short remnant", () => {
    expect(draftCarriesSend("anything", null)).toBe(false);
    expect(draftCarriesSend("anything", "   ")).toBe(false);
    // "a" IS a substring of the send, but one stray character is not evidence our text landed.
    expect(draftCarriesSend("a much longer message", "a")).toBe(false);
  });

  it("requires the whole thing when the send is shorter than the floor", () => {
    expect(draftCarriesSend("ok", "ok")).toBe(true);
    expect(draftCarriesSend("ok", "o")).toBe(false);
  });

  it("rejects an unrelated draft", () => {
    expect(draftCarriesSend("deploy to prod", "someone else's leftover")).toBe(false);
  });

  it("accepts a CJK draft wrapped mid-run (the fold fabricates a space the send never had)", () => {
    // A Japanese draft has no word boundaries, so the input box wraps it mid-run and the
    // space-joined fold yields a space absent from the sent text. This stalled every wrapped
    // Japanese reply: the guard never verified the text and withheld the submit key.
    const sent = "これちなみに電池寿命的にはどうなんだろね。";
    expect(draftCarriesSend(sent, "これちなみに電池寿命的にはどうなん だろね。")).toBe(true);
    // A windowed (tail-only) slice of a wrapped CJK draft still matches.
    expect(draftCarriesSend(sent, "電池寿命的にはどうなん だろね。")).toBe(true);
    // An unrelated CJK remnant still fails.
    expect(draftCarriesSend(sent, "別の誰かの下書きです、これは。")).toBe(false);
  });

  it("accepts mixed CJK/latin text wrapped at either kind of seam", () => {
    // The case no language test could handle: ONE draft carrying both a genuine space (between
    // "pull" and "request") and a fabricated one (wherever the box broke the CJK run).
    const sent = "これは pull request のテストです";
    expect(draftCarriesSend(sent, "これは pull request のテ ストです")).toBe(true); // mid-CJK break
    expect(draftCarriesSend(sent, "これは pull request のテストです")).toBe(true); // at the space
    expect(draftCarriesSend(sent, "これは pull request のテストです")).toBe(true); // no wrap at all
  });

  it("still rejects a draft that lost or altered a non-space character", () => {
    // Only the WIDTH of a gap is unknowable — every visible character must still be there. A box
    // showing text with a space genuinely missing is NOT our text and must not be verified.
    expect(draftCarriesSend("deploy the app", "deploythe app")).toBe(false);
    const sent = "これを実行して結果を教えてください";
    expect(draftCarriesSend(sent, "これを実行して結果を")).toBe(true); // a prefix is a slice
    expect(draftCarriesSend(sent, "これを実行させて結果を")).toBe(false); // an inserted char is not
  });

  it("still requires the visible runs to be contiguous in the send", () => {
    // The relaxation must not degrade into a fuzzy "these words appear somewhere" match: whatever
    // sits between two runs in the send has to be whitespace, or it isn't a contiguous slice.
    expect(draftCarriesSend("deploy the app to prod", "deploy app")).toBe(false);
    expect(draftCarriesSend("送信して、確認して", "送信して 確認して")).toBe(false);
  });

  it("only lets a gap the fold could have made collapse to nothing", () => {
    // The fold's seam is always exactly one plain space. Any other whitespace was really on screen,
    // so the send has to carry whitespace there too — otherwise the screen holds a different
    // message. U+3000 between two CJK runs is the case that matters in Japanese.
    expect(draftCarriesSend("危険実行してください", "危険　実行してください")).toBe(false);
    expect(draftCarriesSend("危険　実行してください", "危険　実行してください")).toBe(true);
    // A gap the fold cannot make is not loosened at all — it must appear in the send verbatim, so a
    // full-width space on screen never verifies a half-width one in the send, or vice versa.
    expect(draftCarriesSend("delete file now", "delete　file now")).toBe(false);
    expect(draftCarriesSend("deploy the app now", "deploy  the app now")).toBe(false);
    expect(draftCarriesSend("deploy  the app now", "deploy  the app now")).toBe(true);
    // ...but a wrap AT that whitespace folds it down to the seam, and the seam still collapses —
    // the tolerance is one-directional, keyed on what the DRAFT shows, not on what the send holds.
    expect(draftCarriesSend("deploy  the app now", "deploy the app now")).toBe(true);
    expect(draftCarriesSend("delete　file now", "delete file now")).toBe(true);
    // A single space still collapses — that is the wrapped-CJK case the guard exists for.
    expect(draftCarriesSend("これを実行してください", "これを実行 してください")).toBe(true);
  });

  it("counts the floor in visible characters, not UTF-16 code units", () => {
    // A ZWJ family sequence is 11 code units but ONE character on screen. Counting code units let a
    // single glyph clear the 8-character floor and pass as evidence that the message landed.
    const family = "👨‍👩‍👧‍👦";
    expect(draftCarriesSend(`please explain ${family} before proceeding`, family)).toBe(false);
    expect(draftCarriesSend(`${family}${family}`, `${family}${family}`)).toBe(true); // whole send
  });

  it("requires the match to land on visible-character boundaries", () => {
    // "👩‍👧‍👦" is a code-unit substring of "👨‍👩‍👧‍👦" while being a different character. Matching
    // mid-character would let the screen show one emoji and verify as another.
    expect(draftCarriesSend("👨‍👩‍👧‍👦", "👩‍👧‍👦")).toBe(false);
    expect(draftCarriesSend("👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦")).toBe(true);
    // The END of the match is checked too, not just its start: "abcdefgh" stops inside the "h" +
    // combining-acute cluster here, so it is not a slice of what we sent. Both sides are long
    // enough that the floor is not what rejects it — the boundary check has to be doing the work.
    expect(draftCarriesSend("abcdefgh́ then more", "abcdefgh")).toBe(false);
    // A windowed tail that DOES start on a boundary is a legitimate slice and must still pass.
    expect(draftCarriesSend("café opened wide", "é opened wide")).toBe(true);
  });

  it("checks every occurrence, not only the first", () => {
    // The first "abcdefgh" here ends inside a combining cluster; the second is properly aligned.
    // Bailing after one hit would stall a reply whose text is verifiably on screen.
    expect(draftCarriesSend("abcdefgh́ then abcdefgh", "abcdefgh")).toBe(true);
  });

  it("does not let invisible controls pad the floor", () => {
    // Segmenter calls each LRM its own cluster, so this is EIGHT clusters carrying FOUR readable
    // characters — exactly enough to clear the floor while showing half of it. Four LRMs, not
    // three: at three the string is seven clusters and the floor rejects it whatever we count.
    const padded = "\u200EA\u200EB\u200EC\u200ED";
    expect(draftCarriesSend(`prefix ${padded} suffix`, padded)).toBe(false);
    // A control INSIDE a cluster still joins visible characters, so the emoji stays one character.
    // Eight of them is exactly the floor, so this fails if a ZWJ cluster is counted as nothing.
    const family = "👨‍👩‍👧‍👦";
    expect(draftCarriesSend(`prefix ${family.repeat(8)} suffix`, family.repeat(8))).toBe(true);
  });

  it("treats regex metacharacters in the draft as literal text", () => {
    expect(draftCarriesSend("run a.*b now", "run a.*b now")).toBe(true);
    expect(draftCarriesSend("run axxb now", "run a.*b now")).toBe(false);
  });

  it("still verifies a wrapped draft on an engine without Intl.Segmenter", async () => {
    // This module is in the main chunk, so a module-scope `new Intl.Segmenter` would throw at
    // evaluation on Firefox < 125 / Safari < 14.1 and white-screen the app at boot. Import it with
    // the constructor gone: it must load, and the guard must keep working at per-code-point
    // precision — the degradation is grapheme accuracy, never the app.
    const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter")!;
    // @ts-expect-error — Intl.Segmenter is not optional in the lib types; that is the point.
    delete Intl.Segmenter;
    vi.resetModules();
    try {
      const legacy = await import("./actions");
      const sent = "これちなみに電池寿命的にはどうなんだろね。";
      expect(legacy.draftCarriesSend(sent, "これちなみに電池寿命的にはどうなん だろね。")).toBe(
        true,
      );
      expect(legacy.draftCarriesSend(sent, "別の誰かの下書きです、これは。")).toBe(false);
    } finally {
      Object.defineProperty(Intl, "Segmenter", segmenter);
      vi.resetModules();
    }
  });
});

describe("sendGuardedReply", () => {
  it("types, verifies the text on the input line, then submits", async () => {
    const calls = harness(() => paneWithDraft("ship it please"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "claude",
      ...instant,
    });

    expect(out).toEqual({ status: "sent" });
    // Two calls, in order: type without submitting, then submit-only with EMPTY text so the bridge
    // sends nothing but its configured submitKeys.
    expect(calls).toEqual([
      { text: "ship it please", submit: false },
      { text: "", submit: true },
    ]);
  });

  it("rescues with a second Enter when the draft is still in the box after submit", async () => {
    // Cursor CLI / Grok on Windows ConPTY: the first Enter is swallowed or rewritten as a newline,
    // so the verified text sits unsubmitted. A later input event flushes it.
    const calls = harness(() => paneWithDraft("ship it please"), { keepDraftAfterSubmit: true });

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "claude",
      ...instant,
    });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text: "ship it please", submit: false },
      { text: "", submit: true },
      { text: "", submit: true, submit_keys: ["Enter"] },
    ]);
  });

  it("flushes Cursor's paste burst with Right before Enter", async () => {
    const cursorPane = [
      "→ hello from phone",
      "",
      "Auto",
      String.raw`C:\claudeOS`,
    ].join("\n");
    const calls = harness(() => cursorPane);
    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "hello from phone",
      agent: "cursor",
      ...instant,
    });
    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text: "hello from phone", submit: false },
      { text: "", submit: true, submit_keys: ["Right", "Enter"] },
    ]);
  });

  // The PRE-FLIGHT (.adr/0009). The verify-after guard below already kept Enter from answering a
  // dialog; this keeps the MESSAGE from being deposited in one, which is what the `/model` picker
  // exposed — no input box at all, so the text went into the picker before anything noticed.
  it("blocks before typing when the adapter can't see an input box", async () => {
    const calls = harness(() => paneWithDialog);

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      ...instant,
    });

    expect(out.status).toBe("blocked");
    expect(out).toMatchObject({ error: expect.stringMatching(/input box isn't on screen/i) });
    // Nothing was typed AT ALL — not even the unsubmitted send_text.
    expect(calls).toEqual([]);
  });

  // collie#103. The refusal is the same refusal — what changes is that the caller is told WHICH screen it
  // refused at, because at a password prompt "a menu or dialog is probably up" sends the operator
  // looking for a dialog to answer and waiting for an echo that is never coming.
  it("collie#103: names the password prompt it refused at, and still types nothing", async () => {
    const calls = harness(() => "$ sudo systemctl restart sighter\n[sudo] password for altan:");

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "hunter2hunter2",
      agent: "claude",
      ...instant,
    });

    expect(out).toMatchObject({
      status: "blocked",
      error: expect.stringMatching(/password prompt/i),
      noEcho: "[sudo] password for altan:",
    });
    expect(calls).toEqual([]);
  });

  it("collie#103: a stall at a password prompt says the text is already in the pane", async () => {
    // The path a `force` takes: the pre-flight was overridden, so the secret IS typed, and then the
    // verification can never succeed because the prompt shows nothing. The caller must hear that a
    // re-send types a SECOND copy rather than recovering a lost one.
    const calls = harness(() => "[sudo] password for altan:");

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "hunter2hunter2",
      agent: "claude",
      force: true,
      ...instant,
    });

    expect(out).toMatchObject({
      status: "stalled",
      noEcho: "[sudo] password for altan:",
      error: expect.stringMatching(/already in the pane/i),
    });
    // Still no submit key — the guard's own contract is untouched by any of this.
    expect(calls).toEqual([{ text: "hunter2hunter2", submit: false }]);
  });

  it("collie#103: a stall on a screen the adapter still recognises is NOT called a password prompt", async () => {
    // The dangerous false positive: an agent whose last printed line happens to read "Enter
    // passphrase:" while its own input box is right there. The stall is then an ordinary one, and
    // calling it no-echo would have the UI advise pressing Enter — the collie#34 keystroke.
    harness(() => "[sudo] password for altan:");
    const real = registry.adapterFor("claude")!;
    // An adapter that says "my composer is right there" about the very screen the detector would
    // otherwise claim. Its draft never carries the send, so the send still stalls — the question this
    // pins is only whether the stall gets NAMED a password prompt. It must not be.
    const spy = vi.spyOn(registry, "adapterFor").mockReturnValue({
      ...real,
      composerReady: () => true,
      extractInputDraft: () => null,
    });

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do the thing",
      agent: "claude",
      ...instant,
    });

    expect(out.status).toBe("stalled");
    expect(out).not.toHaveProperty("noEcho");
    spy.mockRestore();
  }, 15000);

  it("collie#34: force overrides the pre-flight's refusal but still never sends the submit key blind", async () => {
    const calls = harness(() => paneWithDialog);

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      force: true,
      ...instant,
    });

    expect(out.status).toBe("stalled");
    // THE regression assertion. The old path sent Enter here, which approved the highlighted "Yes".
    expect(calls.some((c) => c.submit)).toBe(false);
    expect(calls).toEqual([{ text: "please do not approve anything", submit: false }]);
  });

  it("the stalled message warns that a key answer probably landed", async () => {
    harness(() => paneWithDialog);
    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      force: true,
      ...instant,
    });
    expect(out).toMatchObject({ error: expect.stringMatching(/that key likely landed/i) });
  });

  it("collie#34: does not mistake somebody else's stranded draft for our text", async () => {
    const calls = harness(() => paneWithDraft("an unrelated leftover line"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      ...instant,
    });

    expect(out.status).toBe("stalled");
    expect(calls.some((c) => c.submit)).toBe(false);
  });

  // A send long enough to trip Claude's paste heuristic never appears in the box as itself — the box
  // holds `[Pasted text #N +M lines]`, so the generic matcher can never see our words and the send
  // stalled forever, un-sendable, with every retry re-collapsing (.adr/0010). The adapter's
  // supplemental evidence is what closes that.
  it("submits when the box holds a paste placeholder consistent with a long multi-line send", async () => {
    const calls = harness(() => paneWithDraft("[Pasted text #3 +3 lines]"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "first line\nsecond line\nthird line\nfourth line",
      agent: "claude",
      ...instant,
    });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text: "first line\nsecond line\nthird line\nfourth line", submit: false },
      { text: "", submit: true },
    ]);
  });

  it("stalls on a placeholder inconsistent with what we sent — no submit key", async () => {
    // `#N` is a session counter we cannot predict, so somebody else's leftover token looks exactly
    // like ours; the line count is the only thing tying it to THIS send. 9 lines were never typed.
    const calls = harness(() => paneWithDraft("[Pasted text #7 +9 lines]"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "first line\nsecond line\nthird line\nfourth line",
      agent: "claude",
      ...instant,
    });

    expect(out.status).toBe("stalled");
    expect(calls.some((c) => c.submit)).toBe(false);
  });

  it("submits when Grok rewrote an image path into [Image #N]", async () => {
    const path = String.raw`C:\Users\me\AppData\Local\sighter\uploads\w1_p1-abc-12345678.png`;
    const grokBox = (draft: string) => {
      const width = 120;
      const fill = (open: string, body: string, close: string, filler: string): string =>
        open + body + filler.repeat(Math.max(0, width - open.length - body.length - close.length)) + close;
      return [
        fill("╭", "", "╮", "─"),
        fill("│ ❯ ", draft, " │", " "),
        fill("╰", "", " Grok 4.6 (high) ─╯", "─"),
        "  Shift+Tab:mode  │  Ctrl+x:shortcuts",
      ].join("\n");
    };
    const calls = harness(() => grokBox("[Image #1] look at this"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: `look at this ${path}`,
      agent: "grok",
      ...instant,
    });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text: `look at this ${path}`, submit: false },
      { text: "", submit: true },
    ]);
  });

  it("stalls on a Grok image chip when the send had no image path — no submit key", async () => {
    const grokBox = (draft: string) => {
      const width = 120;
      const fill = (open: string, body: string, close: string, filler: string): string =>
        open + body + filler.repeat(Math.max(0, width - open.length - body.length - close.length)) + close;
      return [
        fill("╭", "", "╮", "─"),
        fill("│ ❯ ", draft, " │", " "),
        fill("╰", "", " Grok 4.6 (high) ─╯", "─"),
        "  Shift+Tab:mode  │  Ctrl+x:shortcuts",
      ].join("\n");
    };
    const calls = harness(() => grokBox("[Image #1]"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "https://example.com/photo",
      agent: "grok",
      ...instant,
    });

    expect(out.status).toBe("stalled");
    expect(calls.some((c) => c.submit)).toBe(false);
  });

  it("submits a Grok URL whose italic ghost tail is not in what we typed", async () => {
    const grokBox = [
      "╭" + "─".repeat(78) + "╮",
      "│ > https://example.com\x1b[3m/extra/path\x1b[0m" + " ".repeat(40) + "│",
      "╰" + "─".repeat(50) + " Grok 4.6 (high) ─╯",
      "  Tab/→:accept suggestion  │  Shift+Tab:mode  │  Ctrl+x:shortcuts",
    ].join("\n");
    const calls = harness(() => grokBox);

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "https://example.com",
      agent: "grok",
      ...instant,
    });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text: "https://example.com", submit: false },
      { text: "", submit: true },
    ]);
  });

  it("keeps the legacy one-shot send for a harness with no adapter", async () => {
    // No grammar → the input box is unreadable, so there is nothing to verify against. Guessing
    // would strand a no-echo input (a shell's sudo prompt) with the submit key withheld forever.
    const calls = harness(() => paneWithDialog);

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ls -la",
      agent: "shell",
      ...instant,
    });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([{ text: "ls -la", submit: true }]);
  });

  it("surfaces a failed type call without submitting", async () => {
    const calls: Array<{ submit: boolean }> = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        calls.push((await request.json()) as { submit: boolean });
        return HttpResponse.json({ ok: false, error: "herdr socket down" });
      }),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "claude",
      ...instant,
    });

    expect(out).toEqual({ status: "error", error: "herdr socket down" });
    expect(calls.some((c) => c.submit)).toBe(false);
  });

  it("reports textDelivered when the text landed but the submit key failed", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () =>
        HttpResponse.json({
          paneId: "w1:p1",
          text: paneWithDraft("ship it please"),
          truncated: false,
          revision: 1,
        }),
      ),
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = (await request.json()) as { submit: boolean };
        return body.submit
          ? HttpResponse.json({ ok: false, error: "keys failed" })
          : HttpResponse.json({ ok: true });
      }),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "claude",
      ...instant,
    });

    expect(out.status).toBe("error");
    expect(out).toMatchObject({ textDelivered: true });
  });
});

// The destructive pre-type work — composer.tsx's `ctrl+k` + N×Backspace sweep of a stranded input
// line — is the one thing this module sends that NOTHING downstream can withhold. Once those keys are
// on the wire they have landed in whatever owns the keyboard; the type-then-verify guard below only
// ever protects the submit key. So the sweep gets a stricter rule than the message does: it runs only
// where a live read has POSITIVELY SEEN the composer, and it is enforced by the pre-flight handing
// back a runner on that one branch rather than by any condition at the call site. These are the paths
// that used to skip the read and sweep anyway.
describe("onComposerSeen — destructive pre-type work needs positive evidence", () => {
  /** The composer's callback shape, recording rather than sending. */
  function sweep(log: string[]) {
    return async () => {
      log.push("sweep");
      return { ok: true as const, keysSent: true };
    };
  }

  it("runs after the pre-flight's read and before the first byte typed", async () => {
    const log: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => {
        log.push("read");
        return HttpResponse.json({
          paneId: "w1:p1",
          text: paneWithDraft("ship it please"),
          truncated: false,
          revision: 1,
        });
      }),
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = (await request.json()) as { submit?: boolean };
        log.push(body.submit ? "submit" : "type");
        return HttpResponse.json({ ok: true });
      }),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "claude",
      onComposerSeen: sweep(log),
      ...instant,
    });

    expect(out.status).toBe("sent");
    // read → sweep → (the re-confirming read the sweep's own `keysSent` asks for) → type → submit.
    expect(log.slice(0, 4)).toEqual(["read", "sweep", "read", "type"]);
  });

  it("force: overrides the refusal, and does NOT sweep the screen that just refused", async () => {
    // `force` is armed by composer.tsx exactly when a pre-flight answered `blocked` — the one moment
    // the app has proof a dialog owns the keyboard. The retry used to make the burst the first thing
    // on the wire, into that dialog.
    const log: string[] = [];
    const calls = harness(() => paneWithDialog);

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      force: true,
      onComposerSeen: sweep(log),
      ...instant,
    });

    expect(log).toEqual([]);
    expect(out.status).toBe("stalled");
    expect(calls.some((c) => c.submit)).toBe(false);
  });

  it("a pre-flight read that throws fails open for the message and closed for the keys", async () => {
    // Falling through on a transient blip is right for the text — the submit key is still withheld
    // until the text is seen. It was never right for keys nothing downstream can take back.
    const log: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.error()),
      http.post(/\/api\/pane\/[^/]+\/reply$/, () => HttpResponse.json({ ok: true })),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      onComposerSeen: sweep(log),
      ...instant,
    });

    expect(log).toEqual([]);
    expect(out.status).toBe("stalled");
  });

  it("an adapter with no composerReady never sweeps", async () => {
    // Registered (so the legacy one-shot path is off) but with no pre-flight to order anything
    // behind. "Keeps today's behaviour exactly" used to include the unordered burst; it no longer
    // does, and the text-then-verify guard is unchanged.
    const log: string[] = [];
    const real = registry.adapterFor("claude")!;
    const spy = vi.spyOn(registry, "adapterFor").mockReturnValue({ ...real, composerReady: undefined });
    try {
      const calls = harness(() => paneWithDialog);
      const out = await sendGuardedReply({
        paneId: "w1:p1",
        text: "please do not approve anything",
        agent: "claude",
        onComposerSeen: sweep(log),
        ...instant,
      });
      expect(log).toEqual([]);
      expect(out.status).toBe("stalled");
      expect(calls.some((c) => c.submit)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("re-confirms the composer between the keys and the message", async () => {
    // The ordering fix moved the sweep BETWEEN the pre-flight and the type, which widened the gap the
    // pre-flight's evidence has to cover by a key-burst RPC plus the caller's TUI settle. A dialog
    // that opens inside that window would otherwise be handed the reply — the very outcome the
    // ordering exists to prevent, one step later.
    const log: string[] = [];
    let reads = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => {
        reads += 1;
        return HttpResponse.json({
          paneId: "w1:p1",
          text: reads === 1 ? paneWithDraft("") : paneWithDialog,
          truncated: false,
          revision: reads,
        });
      }),
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = (await request.json()) as { submit?: boolean };
        log.push(body.submit ? "submit" : "type");
        return HttpResponse.json({ ok: true });
      }),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      onComposerSeen: sweep(log),
      ...instant,
    });

    expect(log).toEqual(["sweep"]); // the sweep was authorised; the message was not
    expect(out.status).toBe("blocked");
    expect(out).toMatchObject({ error: expect.stringMatching(/while its input line was being cleared/i) });
  });

  it("skips the re-confirming read when the caller put nothing on the wire", async () => {
    // The common send: no stranded draft, so the callback sends no keys and the pre-flight's read is
    // still the freshest thing there is. Paying for a second read there would be pure latency.
    let reads = 0;
    let submitted = false;
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => {
        reads += 1;
        return HttpResponse.json({
          paneId: "w1:p1",
          text: submitted ? paneWithDraft("") : paneWithDraft("ship it please"),
          truncated: false,
          revision: 1,
        });
      }),
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = (await request.json()) as { submit?: boolean };
        if (body.submit) submitted = true;
        return HttpResponse.json({ ok: true });
      }),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "claude",
      onComposerSeen: async () => ({ ok: true as const, keysSent: false }),
      ...instant,
    });

    expect(out.status).toBe("sent");
    // pre-flight, verification poll, then one post-submit confirm that the draft left. No
    // re-confirm between sweep (none) and type.
    expect(reads).toBe(3);
  });

  it("aborts with nothing typed when the pre-type work fails or throws", async () => {
    const calls = harness(() => paneWithDraft(""));

    expect(
      await sendGuardedReply({
        paneId: "w1:p1",
        text: "ship it please",
        agent: "claude",
        onComposerSeen: async () => ({ ok: false as const, error: "Couldn't clear the terminal input" }),
        ...instant,
      }),
    ).toEqual({ status: "error", error: "Couldn't clear the terminal input" });

    expect(
      await sendGuardedReply({
        paneId: "w1:p1",
        text: "ship it please",
        agent: "claude",
        onComposerSeen: async () => {
          throw new Error("network down");
        },
        ...instant,
      }),
    ).toEqual({ status: "error", error: "network down" });

    expect(calls).toEqual([]);
  });
});

// Ordering is not a freshness bound. `runPreType` existing proves a read SAW the composer; it cannot
// prove the composer is still there when the keys land, because the read's answer describes the pane
// at the moment the bridge snapshotted it and the burst goes out a whole round-trip later (capped
// only by GET_TIMEOUT_MS). Every other keystroke path in the app already solves this the same way:
// bind the write to the region it was authorised against and let the bridge re-read and 409. So the
// pre-flight hands its evidence forward, not just its permission.
describe("the pre-type work is handed the region its keys must be bound to", () => {
  const grokPane = (draft: string, below: string[] = []): string => {
    const width = 120;
    const fill = (open: string, body: string, close: string, filler: string): string =>
      open + body + filler.repeat(Math.max(0, width - open.length - body.length - close.length)) + close;
    return [
      " ✔ New session started",
      "",
      fill("╭", "", "╮", "─"),
      fill("│ ❯ ", draft, " │", " "),
      fill("╰", "", " Grok 4.6 (high) · always-approve ─╯", "─"),
      ...below,
    ].join("\n");
  };

  it("passes grok's own `│ ❯ … │` row, verbatim, from the screen the pre-flight read", async () => {
    let seenRegion: string | null | undefined;
    harness(() => grokPane("leftover draft"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "grok",
      onComposerSeen: async ({ promptRegion }) => {
        seenRegion = promptRegion;
        return { ok: true as const, keysSent: false };
      },
      ...instant,
    });

    // The reply itself stalls here (the fake screen never echoes our text back), which is beside the
    // point: what is pinned is that the region reached the caller at all, and that it is the exact
    // line the sweep is about to erase rather than a paraphrase of it.
    expect(out.status).toBe("stalled");
    expect(seenRegion).toContain("leftover draft");
    expect(seenRegion!.startsWith("│ ❯ ")).toBe(true);
    expect(seenRegion!.endsWith("│")).toBe(true);
    // Verbatim minus trailing padding — the bridge compares normalized rows, and a region we had
    // reshaped would not match the row it is meant to pin.
    expect(seenRegion).toBe(grokPane("leftover draft").split("\n")[3]!.replace(/\s+$/, ""));
  });

  it("passes null when the adapter cannot name a region, so the write stays unbound", async () => {
    // Claude's adapter has no `composerPrompt`: its prompt line sits above a statusline run and a
    // footer, i.e. too far from the tail for the bridge's binding window. Absence is the documented
    // default and keeps that path exactly as it was.
    let seenRegion: string | null | undefined = "unset";
    harness(() => paneWithDraft("ship it please"));

    await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "claude",
      onComposerSeen: async ({ promptRegion }) => {
        seenRegion = promptRegion;
        return { ok: true as const, keysSent: false };
      },
      ...instant,
    });

    expect(seenRegion).toBeNull();
  });

  it("never hands out a region for a screen it refused", async () => {
    // The runner is the permission and the region is the evidence; neither may exist without a live
    // read having positively seen the composer. A modal screen produces no runner at all.
    const log: string[] = [];
    harness(() => "╭─ Ask ─────╮\n│ Pick one  │\n╰───────────╯");

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "grok",
      onComposerSeen: async ({ promptRegion }) => {
        log.push(String(promptRegion));
        return { ok: true as const, keysSent: true };
      },
      ...instant,
    });

    expect(out.status).toBe("blocked");
    expect(log).toEqual([]);
  });
});
});
