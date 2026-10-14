import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPane, sendKeys, sendReply } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type StyledLine, type WizardModel } from "./blocks";
import { detectWizard } from "./harness/claude/wizard";
import { detectPiWizardRegion } from "./harness/pi/ask";
import { submitWizardFeedback, submitWizardKeys } from "./wizard-action";

vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
}));

// The wizard race guard (#52). The api layer is mocked so the pane can move to another step between
// the render the user tapped and the read the guard takes; the detector is the real Claude one,
// driven by captured screens.

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);
const mockSendReply = vi.mocked(sendReply);

const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const fixtureText = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");

function fixtureModel(name: string): WizardModel {
  const model = detectWizard(splitLines(parseAnsi(fixtureText(name))));
  if (!model) throw new Error(`fixture ${name} did not detect a wizard`);
  return model;
}

function pane(text: string) {
  mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text, truncated: false, revision: 0 });
}

const base = { paneId: "w1:p1", requestedLines: 200, detectedRevision: 0, agent: "claude" };

beforeEach(() => {
  vi.clearAllMocks();
  mockSendKeys.mockResolvedValue({ ok: true });
  mockSendReply.mockResolvedValue({ ok: true });
});

describe("submitWizardKeys", () => {
  it("sends the keystroke when the same step is still on screen", async () => {
    pane(fixtureText("claude--wizard-q1.txt"));

    const res = await submitWizardKeys({ ...base, wizard: fixtureModel("claude--wizard-q1.txt"), keys: ["1"] });

    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["1"], expect.any(String));
  });

  it("refuses when the wizard moved to another step underfoot", async () => {
    pane(fixtureText("claude--wizard-q2.txt"));

    const res = await submitWizardKeys({ ...base, wizard: fixtureModel("claude--wizard-q1.txt"), keys: ["1"] });

    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("refuses once the wizard is gone", async () => {
    pane("just ordinary output now");

    const res = await submitWizardKeys({ ...base, wizard: fixtureModel("claude--wizard-q1.txt"), keys: ["1"] });

    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("refuses without an agent, since no adapter can re-derive the screen", async () => {
    pane(fixtureText("claude--wizard-q1.txt"));
    const { agent: _agent, ...noAgent } = base;

    const res = await submitWizardKeys({ ...noAgent, wizard: fixtureModel("claude--wizard-q1.txt"), keys: ["1"] });

    expect(res.status).not.toBe("sent");
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("maps a bridge prompt_changed refusal to changed", async () => {
    pane(fixtureText("claude--wizard-q1.txt"));
    mockSendKeys.mockResolvedValue({ ok: false, code: "prompt_changed", error: "prompt changed" });

    const res = await submitWizardKeys({ ...base, wizard: fixtureModel("claude--wizard-q1.txt"), keys: ["1"] });

    expect(res).toEqual({ status: "changed" });
  });
});

function line(text: string): StyledLine {
  return { segments: [{ text, style: {}, muted: false }] };
}

function piFrame(body: string[]): string {
  const rule = "─".repeat(40);
  return [
    rule,
    " ←  □ Color   □ Size   ✓ Submit  →",
    "",
    " Which color?",
    "",
    ...body,
    rule,
    "~/Projects/tools/sighter",
    "↑1.5k ↓3.4k 4.1%/200k (auto)  muse-spark-1.3 • medium",
  ].join("\n");
}

const piIdle = piFrame([
  "> 1. Red",
  "  2. Blue",
  "  3. Type something.",
  "",
  " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel",
]);

const piEditor = (text: string) =>
  piFrame([
    "  1. Red",
    "  2. Blue",
    "> 3. Type something. ✎",
    "",
    " Your answer:",
    " ────────",
    text,
    " ────────",
    "",
    " Enter to submit • Esc to cancel",
  ]);

describe("submitWizardFeedback — Pi arrows, editor, type, Enter", () => {
  const noSleep = async () => {};

  function modelOf(text: string): WizardModel {
    const region = detectPiWizardRegion(text.split("\n").map(line));
    if (!region) throw new Error("pi frame did not lift");
    return region.model;
  }

  it("walks onto Type something, types, and submits only after the text is in the editor", async () => {
    const idle = modelOf(piIdle);
    const filled = modelOf(piEditor(" papaya"));
    mockFetchPane
      .mockResolvedValueOnce({ paneId: "w1:p1", text: piIdle, truncated: false, revision: 0 })
      .mockResolvedValueOnce({ paneId: "w1:p1", text: piEditor(" "), truncated: false, revision: 0 })
      .mockResolvedValue({ paneId: "w1:p1", text: piEditor(" papaya"), truncated: false, revision: 0 });

    const res = await submitWizardFeedback({
      paneId: "w1:p1",
      requestedLines: 200,
      detectedRevision: 0,
      agent: "pi",
      wizard: idle,
      text: "papaya",
      sleep: noSleep,
    });

    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Down", "Down", "Enter"], idle.signature],
      ["w1:p1", ["Enter"], filled.signature],
    ]);
    expect(mockSendReply.mock.calls).toEqual([["w1:p1", "papaya", false]]);
    for (const key of mockSendKeys.mock.calls.flatMap((c) => c[1] as string[])) {
      expect(key).not.toMatch(/^\d+$/);
    }
  });

  it("refuses a digit key and a box that is already open, and sends nothing", async () => {
    const idle = modelOf(piIdle);
    if (idle.phase !== "question" || !idle.feedback) throw new Error("expected feedback");
    const digit = await submitWizardFeedback({
      ...base,
      agent: "pi",
      wizard: { ...idle, feedback: { ...idle.feedback, keys: ["3"] } },
      text: "papaya",
      sleep: noSleep,
    });
    expect(digit).toEqual({
      status: "error",
      error: "This dialog's free-text row is not typed from the phone",
    });
    const open = modelOf(piEditor(" "));
    const editing = await submitWizardFeedback({
      ...base,
      agent: "pi",
      wizard: open,
      text: "papaya",
      sleep: noSleep,
    });
    expect(editing).toEqual({ status: "changed" });
    expect(mockFetchPane).not.toHaveBeenCalled();
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
  });
});
