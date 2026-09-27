import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPane, sendKeys } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type WizardModel } from "./blocks";
import { detectWizard } from "./harness/claude/wizard";
import { submitWizardKeys } from "./wizard-action";

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
