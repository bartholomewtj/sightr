import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchPane, sendKeys } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type MultiSelectModel } from "./blocks";
import { detectMultiSelect } from "./harness/claude/multi-select";
import { cursorAdapter } from "./harness/cursor";
import { grokAdapter } from "./harness/grok";
import { multiSelectEquals, multiSelectIdentity, submitMultiSelectIntent } from "./actions";

vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
}));

describe("multi-select-action", () => {

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

  function twoOption(focus: 1 | 2): string {
    const cell = (n: 1 | 2) => (focus === n ? "70;70;70" : "64;64;64");
    const row = (text: string, bg: string) => `  │  \x1b[48;2;${bg}m${text}\x1b[0m`;
    return [
      "  │  Which tree?",
      row("1 [ ] Oak", cell(1)),
      row("2 [ ] Pine", cell(2)),
      row("z [ ] Type your answer here", "64;64;64"),
      "  │  ↑/↓ navigate · y copy                                                                 Enter:submit",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
  }

  it("a two-option card focused on row 1 Spaces that row and Tabs to row 2", async () => {
    const on1 = twoOption(1);
    const on2 = twoOption(2);
    const m = grokModel(on1);
    expect(m.phase === "checkbox" && m.focusedN).toBe(1);
    mockFetchPane.mockResolvedValue(paneWith(on1));
    const first = await submitMultiSelectIntent({ ...grokBase, multi: m, intent: { kind: "toggle", n: 1 } });
    expect(first).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Space"]]);

    mockSendKeys.mockClear();
    script(on1, on1, on2);
    const second = await submitMultiSelectIntent({ ...grokBase, multi: m, intent: { kind: "toggle", n: 2 } });
    expect(second).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Tab"], ["Space"]]);
  });

  it("a two-option card focused on row 2 Spaces that row, never the letter or digit", async () => {
    const on2 = twoOption(2);
    const m = grokModel(on2);
    expect(m.phase === "checkbox" && m.focusedN).toBe(2);
    mockFetchPane.mockResolvedValue(paneWith(on2));
    const res = await submitMultiSelectIntent({ ...grokBase, multi: m, intent: { kind: "toggle", n: 2 } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Space"]]);
  });
});

// Live-probed 2026-09-27 on Cursor v2026.09.26 (harness/cursor/ASK_NOTES.md § Multi-select).
describe("cursor pointer-space-s checkbox recipe", () => {
  const PANES = join(import.meta.dirname, "..", "fixtures", "panes");
  const cursorBase = { ...base, agent: "cursor" as const };
  const fruit = () => readFileSync(join(PANES, "cursor--ask-multi-fruit.txt"), "utf8");

  function cursorModel(ansi: string): MultiSelectModel {
    const block = cursorAdapter.buildBlocks(splitLines(parseAnsi(ansi))).find((b) => b.kind === "multi-select");
    if (block?.kind !== "multi-select") throw new Error("expected cursor multi-select");
    return block.multi;
  }

  /** Move the `›` pointer from its row onto the row labelled `label`. */
  function pointAt(ansi: string, label: string): string {
    const rows = ansi.split("\n");
    const src = rows.findIndex((l) => l.includes("› ["));
    const dst = rows.findIndex((l) => l.includes(`m${label}`) && l.includes("  [ ]"));
    if (src < 0 || dst < 0) throw new Error(`pointer rows ${src} ${dst}`);
    rows[src] = rows[src]!.replace("› [", "  [");
    rows[dst] = rows[dst]!.replace("  [ ]", "› [ ]");
    return rows.join("\n");
  }

  it("toggle of the pointed row sends Space only", async () => {
    const ansi = fruit();
    mockFetchPane.mockResolvedValue(paneWith(ansi));
    const res = await submitMultiSelectIntent({ ...cursorBase, multi: cursorModel(ansi), intent: { kind: "toggle", n: 1 } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Space"]]);
  });

  it("toggle of a later row walks Down one key per read, then Space — never a digit", async () => {
    const start = fruit();
    script(start, start, pointAt(start, "Banana"), pointAt(start, "Cherry"));
    const res = await submitMultiSelectIntent({ ...cursorBase, multi: cursorModel(start), intent: { kind: "toggle", n: 3 } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Down"], ["Down"], ["Space"]]);
  });

  it("toggle from the Other: row walks Up", async () => {
    const onOther = pointAt(fruit(), "Other:");
    script(onOther, onOther, pointAt(fruit(), "Cherry"));
    const res = await submitMultiSelectIntent({ ...cursorBase, multi: cursorModel(onOther), intent: { kind: "toggle", n: 3 } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Up"], ["Space"]]);
  });

  it("submit sends `s`, never Enter (Enter would add the pointed row)", async () => {
    const ansi = fruit();
    mockFetchPane.mockResolvedValue(paneWith(ansi));
    const res = await submitMultiSelectIntent({ ...cursorBase, multi: cursorModel(ansi), intent: { kind: "advance" } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["s"]]);
  });

  it("submit steps off Other: before `s`, which would type there", async () => {
    const onOther = pointAt(fruit(), "Other:");
    script(onOther, onOther, pointAt(fruit(), "Cherry"));
    const res = await submitMultiSelectIntent({ ...cursorBase, multi: cursorModel(onOther), intent: { kind: "advance" } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Up"], ["s"]]);
  });

  it("a box flipped mid-walk aborts before the final key", async () => {
    const start = fruit();
    const flipped = start.replace("  [ ]\u001b[0m \u001b[0m\u001b[2mBanana", "  [x]\u001b[0m \u001b[0m\u001b[2mBanana");
    expect(flipped).not.toBe(start);
    script(start, start, flipped);
    const res = await submitMultiSelectIntent({ ...cursorBase, multi: cursorModel(start), intent: { kind: "toggle", n: 3 } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).toEqual([["Down"]]);
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
