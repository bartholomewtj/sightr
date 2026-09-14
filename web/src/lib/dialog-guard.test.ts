import { describe, expect, it, beforeEach, vi } from "vitest";

// The GENERIC dialog guard: what every *-action module now runs. The api layer is mocked so the pane
// can be made to drift (or to belong to another agent) between the render the user tapped and the
// read the guard takes; the adapters and the fixture corpus are the real thing.
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fetchPane, sendKeys } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { awaitDialogSettled, dialogDetector, sendGuardedKeys, SETTLE_ATTEMPTS } from "./dialog-guard";
import { submitPromptOption } from "./actions";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);

const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const fixture = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");
const lines = (text: string) => splitLines(parseAnsi(text));

beforeEach(() => {
  vi.clearAllMocks();
  mockSendKeys.mockResolvedValue({ ok: true });
});

function pane(text: string) {
  mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text, truncated: false, revision: 0 });
}

describe("dialogDetector — re-derivation goes through the agent's adapter", () => {
  const permission = fixture("claude--permission-edit.txt");

  it("finds the tail block of the asked-for kind", () => {
    const model = dialogDetector("prompt-select", "claude")(lines(permission));
    expect(model?.family).toBe("permission");
    expect(model?.signature.length).toBeGreaterThan(0);
  });

  it("returns null for a kind this screen doesn't carry", () => {
    expect(dialogDetector("menu", "claude")(lines(permission))).toBeNull();
  });

  // Fail-CLOSED: an agent with no adapter has no verified grammar, so nothing may be re-derived from
  // its buffer — and nothing typed into it. Before the guard went through the registry, each action
  // module re-derived with Claude's detector regardless of whose pane it was.
  it("re-derives NOTHING for an agent with no adapter", () => {
    expect(dialogDetector("prompt-select", "pi")(lines(permission))).toBeNull();
    expect(dialogDetector("prompt-select", undefined)(lines(permission))).toBeNull();
  });
});

describe("the guard refuses when the fresh screen isn't the tapped dialog", () => {
  const permission = fixture("claude--permission-edit.txt");
  const prompt = () => dialogDetector("prompt-select", "claude")(lines(permission))!;

  it("sends when the screen is unchanged", async () => {
    pane(permission);
    const p = prompt();

    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 200,
      detectedRevision: 0,
      agent: "claude",
      prompt: p,
      option: p.options[0]!,
    });

    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", p.options[0]!.keys, p.signature);
  });

  it("refuses (and types nothing) when the pane belongs to an agent with no adapter", async () => {
    pane(permission);
    const p = prompt();

    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 200,
      detectedRevision: 0,
      agent: "pi",
      prompt: p,
      option: p.options[0]!,
    });

    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  // The adapter's ARBITRATION is inherited, not re-litigated: a screen a more specific grammar now
  // claims no longer carries a prompt-select block, so the tap is refused rather than re-parsed
  // through the grammar that lost.
  it("refuses when another grammar now claims the tail", async () => {
    pane(fixture("claude--wizard-q1.txt"));
    const p = prompt();

    const res = await sendGuardedKeys(
      {
        paneId: "w1:p1",
        requestedLines: 200,
        detectedRevision: 0,
        agent: "claude",
        kind: "prompt-select",
        model: p,
      },
      p.options[0]!.keys,
    );

    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});

describe("awaitDialogSettled — #368", () => {
  const single = fixture("claude--select-multiselect-single.txt");
  const checkedCheese = single.replace("1. \x1b[0m[ ]", "1. \x1b[0m[✔]");
  const plainOutput = "plain terminal text\nno dialog here";

  beforeEach(() => {
    mockFetchPane.mockReset();
  });

  it("fixture edit proves Cheese checked === true", () => {
    const initial = dialogDetector("multi-select", "claude")(lines(single))!;
    expect(initial.phase).toBe("checkbox");
    if (initial.phase !== "checkbox") return;
    expect(initial.options[0]!.label).toBe("Cheese");
    expect(initial.options[0]!.checked).toBe(false);

    const after = dialogDetector("multi-select", "claude")(lines(checkedCheese))!;
    expect(after.phase).toBe("checkbox");
    if (after.phase !== "checkbox") return;
    expect(after.options[0]!.label).toBe("Cheese");
    expect(after.options[0]!.checked).toBe(true);
  });

  it("settles on the first changed read (toggle)", async () => {
    const initial = dialogDetector("multi-select", "claude")(lines(single))!;
    mockFetchPane
      .mockResolvedValueOnce({ paneId: "w1:p1", text: single, truncated: false, revision: 1 })
      .mockResolvedValueOnce({ paneId: "w1:p1", text: checkedCheese, truncated: false, revision: 2 });

    const res = await awaitDialogSettled({
      paneId: "w1:p1",
      requestedLines: 200,
      detectedRevision: 1,
      agent: "claude",
      kind: "multi-select",
      model: initial,
      sleep: async () => {},
    });

    expect(res).toEqual({
      status: "settled",
      snapshot: { text: checkedCheese, revision: 2 },
    });
    expect(mockFetchPane).toHaveBeenCalledTimes(2);
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("dialog gone needs two consecutive nulls", async () => {
    const initial = dialogDetector("multi-select", "claude")(lines(single))!;
    mockFetchPane
      .mockResolvedValueOnce({ paneId: "w1:p1", text: plainOutput, truncated: false, revision: 2 })
      .mockResolvedValueOnce({ paneId: "w1:p1", text: single, truncated: false, revision: 3 })
      .mockResolvedValueOnce({ paneId: "w1:p1", text: plainOutput, truncated: false, revision: 4 })
      .mockResolvedValueOnce({ paneId: "w1:p1", text: plainOutput, truncated: false, revision: 5 });

    const res = await awaitDialogSettled({
      paneId: "w1:p1",
      requestedLines: 200,
      detectedRevision: 1,
      agent: "claude",
      kind: "multi-select",
      model: initial,
      sleep: async () => {},
    });

    expect(res).toEqual({
      status: "settled",
      snapshot: { text: plainOutput, revision: 5 },
    });
    expect(mockFetchPane).toHaveBeenCalledTimes(4);
  });

  it("unchanged screen gives timeout after SETTLE_ATTEMPTS reads and sends no keys", async () => {
    const initial = dialogDetector("multi-select", "claude")(lines(single))!;
    mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text: single, truncated: false, revision: 1 });

    const res = await awaitDialogSettled({
      paneId: "w1:p1",
      requestedLines: 200,
      detectedRevision: 1,
      agent: "claude",
      kind: "multi-select",
      model: initial,
      sleep: async () => {},
    });

    expect(res).toEqual({ status: "timeout" });
    expect(mockFetchPane).toHaveBeenCalledTimes(SETTLE_ATTEMPTS);
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("a read that throws keeps polling and does not break a null streak", async () => {
    const initial = dialogDetector("multi-select", "claude")(lines(single))!;
    mockFetchPane
      .mockResolvedValueOnce({ paneId: "w1:p1", text: plainOutput, truncated: false, revision: 2 })
      .mockRejectedValueOnce(new Error("transient network failure"))
      .mockResolvedValueOnce({ paneId: "w1:p1", text: plainOutput, truncated: false, revision: 3 });

    const res = await awaitDialogSettled({
      paneId: "w1:p1",
      requestedLines: 200,
      detectedRevision: 1,
      agent: "claude",
      kind: "multi-select",
      model: initial,
      sleep: async () => {},
    });

    expect(res).toEqual({
      status: "settled",
      snapshot: { text: plainOutput, revision: 3 },
    });
    expect(mockFetchPane).toHaveBeenCalledTimes(3);
  });

  it("identity compare: pointer move does not settle, but nullx2 does", async () => {
    const previewText = fixture("claude--select-preview.txt");
    const previewModel = dialogDetector("preview-select", "claude")(lines(previewText))!;
    expect(previewModel.options[0]?.pointed).toBe(true);

    const movedPreviewText = previewText
      .replace("\x1b[38;2;177;185;249m❯\x1b[0m\x1b[38;2;153;153;153m 1.", " \x1b[0m\x1b[38;2;153;153;153m 1.")
      .replace("\n \x1b[0m\x1b[38;2;153;153;153m 2.", "\n\x1b[38;2;177;185;249m❯\x1b[0m\x1b[38;2;153;153;153m 2.");

    const movedModel = dialogDetector("preview-select", "claude")(lines(movedPreviewText))!;
    expect(movedModel.options[1]?.pointed).toBe(true);

    mockFetchPane
      .mockResolvedValueOnce({ paneId: "w1:p1", text: movedPreviewText, truncated: false, revision: 2 })
      .mockResolvedValueOnce({ paneId: "w1:p1", text: plainOutput, truncated: false, revision: 3 })
      .mockResolvedValueOnce({ paneId: "w1:p1", text: plainOutput, truncated: false, revision: 4 });

    const res = await awaitDialogSettled(
      {
        paneId: "w1:p1",
        requestedLines: 200,
        detectedRevision: 1,
        agent: "claude",
        kind: "preview-select",
        model: previewModel,
        sleep: async () => {},
      },
      "identity",
    );

    expect(res).toEqual({
      status: "settled",
      snapshot: { text: plainOutput, revision: 4 },
    });
    expect(mockFetchPane).toHaveBeenCalledTimes(3);
  });

  it("no-adapter agent ('pi') settles as gone after 2 reads", async () => {
    const initial = dialogDetector("multi-select", "claude")(lines(single))!;
    mockFetchPane
      .mockResolvedValueOnce({ paneId: "w1:p1", text: single, truncated: false, revision: 2 })
      .mockResolvedValueOnce({ paneId: "w1:p1", text: single, truncated: false, revision: 3 });

    const res = await awaitDialogSettled({
      paneId: "w1:p1",
      requestedLines: 200,
      detectedRevision: 1,
      agent: "pi",
      kind: "multi-select",
      model: initial,
      sleep: async () => {},
    });

    expect(res).toEqual({
      status: "settled",
      snapshot: { text: single, revision: 3 },
    });
    expect(mockFetchPane).toHaveBeenCalledTimes(2);
  });
});
