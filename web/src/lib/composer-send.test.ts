import { describe, expect, it, vi } from "vitest";
import { planSendTap, runComposerSend } from "@/lib/composer-send";

const deps = (sendReply: any, extra: any = {}) => ({
  paneId: "p",
  agent: "claude",
  dialogPresent: false,
  force: false,
  isDraft: true,
  confirmDialog: vi.fn(() => false),
  isLocked: vi.fn(() => false),
  terminalLine: null,
  onStart: vi.fn(),
  onKeysSent: vi.fn(),
  sendReply,
  ...extra,
});

const sentReply = async () => ({ status: "sent" });

describe("composer send pipeline", () => {
  it("returns the verified draft result", async () => {
    const result = await runComposerSend(" hi ", deps(sentReply));
    expect(result).toEqual({
      ok: true,
      status: { text: "Sent ✓", tone: "success" },
      clearDraft: true,
      armForce: false,
      resetForce: true,
      noEcho: null,
      sent: "hi",
    });
  });

  it("does not clear a one-tap word", async () => {
    const result = await runComposerSend(
      "yes",
      deps(sentReply, { isDraft: false }),
    );
    expect(result.ok).toBe(true);
    expect(result.clearDraft).toBe(false);
  });

  it("maps blocked pre-flight outcomes", async () => {
    const result = await runComposerSend(
      "x",
      deps(async () => ({ status: "blocked", error: "blocked" })),
    );
    expect(result).toMatchObject({
      ok: false,
      armForce: true,
      status: { text: "blocked Tap Send again to type anyway.", tone: "error" },
    });
  });

  it("carries a blocked password prompt as an untyped notice", async () => {
    const result = await runComposerSend(
      "x",
      deps(async () => ({
        status: "blocked",
        error: "hidden",
        noEcho: "Password",
      })),
    );
    expect(result.noEcho).toEqual({ prompt: "Password", typed: false });
  });

  it("maps stalled outcomes and keeps the draft", async () => {
    const result = await runComposerSend(
      "x",
      deps(async () => ({ status: "stalled", error: "stalled" })),
    );
    expect(result).toMatchObject({
      ok: false,
      armForce: false,
      clearDraft: false,
      status: { text: "stalled", tone: "error" },
    });
  });

  it("carries a stalled password prompt as a typed notice", async () => {
    const result = await runComposerSend(
      "x",
      deps(async () => ({
        status: "stalled",
        error: "stalled",
        noEcho: "Password",
      })),
    );
    expect(result.noEcho).toEqual({ prompt: "Password", typed: true });
  });

  it("maps transport errors", async () => {
    const result = await runComposerSend(
      "x",
      deps(async () => ({ status: "error", error: "network" })),
    );
    expect(result).toMatchObject({
      ok: false,
      status: { text: "network", tone: "error" },
      noEcho: null,
    });
  });

  it("turns thrown errors into an error result", async () => {
    const result = await runComposerSend(
      "x",
      deps(async () => {
        throw new Error("boom");
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      status: { text: "boom", tone: "error" },
    });
  });

  it("refuses a dialog before starting or calling the sender", async () => {
    const sendReply = vi.fn(sentReply);
    const options = deps(sendReply, { dialogPresent: true });
    const result = await runComposerSend("x", options);
    expect(result.status?.text).toBe(
      "A dialog is waiting — tap Send again to type past it.",
    );
    expect(sendReply).not.toHaveBeenCalled();
    expect(options.onStart).not.toHaveBeenCalled();
  });

  it("forces a confirmed dialog through the sender", async () => {
    const sendReply = vi.fn(sentReply);
    await runComposerSend(
      "x",
      deps(sendReply, {
        dialogPresent: true,
        confirmDialog: vi.fn(() => true),
      }),
    );
    expect(sendReply).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it("does not ask for dialog confirmation when force is supplied", async () => {
    const confirmDialog = vi.fn(() => false);
    const sendReply = vi.fn(sentReply);
    await runComposerSend(
      "x",
      deps(sendReply, { force: true, dialogPresent: true, confirmDialog }),
    );
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it("skips pre-clear when there is no terminal line", async () => {
    const sendKeys = vi.fn();
    const sendReply = vi.fn(async (args: any) => {
      expect(await args.onComposerSeen({ promptRegion: "❯ " })).toEqual({
        ok: true,
        keysSent: false,
      });
      return { status: "sent" };
    });
    await runComposerSend("x", deps(sendReply, { sendKeys }));
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("sweeps a terminal line and revalidates keys", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true }));
    const onKeysSent = vi.fn();
    const sendReply = vi.fn(async (args: any) => {
      expect(await args.onComposerSeen({ promptRegion: "❯ " })).toEqual({
        ok: true,
        keysSent: true,
      });
      return { status: "sent" };
    });
    await runComposerSend(
      "abcd",
      deps(sendReply, {
        terminalLine: "abc",
        sendKeys,
        onKeysSent,
        sleep: vi.fn(async () => {}),
      }),
    );
    expect(sendKeys).toHaveBeenCalledWith(
      "p",
      ["ctrl+k", ...Array(35).fill("Backspace")],
            "❯ ",
    );
    expect(onKeysSent).toHaveBeenCalledOnce();
  });

  it("stops the sweep when the live pane becomes locked", async () => {
    const sendKeys = vi.fn();
    const isLocked = vi.fn(() => true);
    const sendReply = vi.fn(async (args: any) => {
      expect(await args.onComposerSeen({ promptRegion: "❯ " })).toMatchObject({
        ok: false,
        error: "Pane is no longer writable — nothing was sent",
      });
      return { status: "stalled", error: "stalled" };
    });
    await runComposerSend(
      "x",
      deps(sendReply, { terminalLine: "draft", sendKeys, isLocked }),
    );
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("reports a prompt change from the destructive sweep", async () => {
    const sendKeys = vi.fn(async () => ({ ok: false, code: "prompt_changed" }));
    const sendReply = vi.fn(async (args: any) => {
      expect(await args.onComposerSeen({ promptRegion: "❯ " })).toMatchObject({
        ok: false,
        error:
          "The input box changed while clearing it — nothing was typed. Check the pane.",
      });
      return { status: "stalled", error: "stalled" };
    });
    await runComposerSend(
      "x",
      deps(sendReply, { terminalLine: "draft", sendKeys }),
    );
  });

  it("plans force, destructive confirmation, confirmed destructive, and plain taps", () => {
    expect(
      planSendTap("x", {
        forceArmed: true,
        destructiveConfirmed: false,
        destructiveReason: null,
      }),
    ).toEqual({ kind: "send", force: true });
    expect(
      planSendTap("x", {
        forceArmed: false,
        destructiveConfirmed: false,
        destructiveReason: "rm",
      }),
    ).toEqual({
      kind: "arm-destructive",
      status: {
        text: "Destructive: rm — tap Send again to confirm",
        tone: "info",
      },
    });
    expect(
      planSendTap("x", {
        forceArmed: false,
        destructiveConfirmed: true,
        destructiveReason: "rm",
      }),
    ).toEqual({ kind: "send", force: false });
    expect(
      planSendTap("x", {
        forceArmed: false,
        destructiveConfirmed: false,
        destructiveReason: null,
      }),
    ).toEqual({ kind: "send", force: false });
  });
});
