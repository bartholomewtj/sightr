import { cleanup, fireEvent, render, screen, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useDirectTyping } from "./use-direct-typing";
import { clearStatus, useStatus } from "@/lib/status";
import { pasteHold, __resetPasteHold } from "@/lib/paste-hold";
import { textToKeySequence } from "@/lib/key-queue";

// Folded from use-direct-typing-desktop.test.tsx.
describe('use-direct-typing-desktop.test', () => {
  function StatusSentinel() { const status = useStatus(); return <output data-testid="status">{status?.text ?? ""}</output>; }

  function Probe({ desktop, draft = "", onDraftRead }: { desktop: boolean; draft?: string; onDraftRead?: () => void }) {
    const input = useRef<HTMLTextAreaElement>(null);
    const lockedDraft = false;
    const direct = useDirectTyping({ paneKey: "p", inputRef: input, replyDraft: () => { onDraftRead?.(); return draft; }, canActivate: () => !lockedDraft, suspended: lockedDraft, sendKeys: vi.fn(async () => true), onActivate: vi.fn(), focusInput: () => input.current?.focus(), desktop });
    return <><textarea ref={input} onBlur={direct.onBlur} data-testid="input" /><button onClick={direct.activate}>arm</button><output data-testid="active">{String(direct.active)}</output></>;
  }

  beforeEach(() => { localStorage.clear(); clearStatus(); });
  afterEach(() => { cleanup(); });

  describe("useDirectTyping desktop", () => {
    it("keeps phone draft refusal and status", () => { render(<><StatusSentinel /><Probe desktop={false} draft="draft" /></>); fireEvent.click(screen.getByText("arm")); expect(screen.getByTestId("active")).toHaveTextContent("false"); expect(screen.getByTestId("status")).toHaveTextContent("Send or clear the draft before typing into the terminal."); });
    it("bypasses draft refusal on desktop without mutating the draft", () => { const read = vi.fn(); render(<Probe desktop draft="draft" onDraftRead={read} />); fireEvent.click(screen.getByText("arm")); expect(screen.getByTestId("active")).toHaveTextContent("true"); expect(read).not.toHaveBeenCalled(); });
    it("releases on desktop blur but not phone blur", () => { const { rerender } = render(<Probe desktop />); fireEvent.click(screen.getByText("arm")); fireEvent.blur(screen.getByTestId("input")); expect(screen.getByTestId("active")).toHaveTextContent("false"); rerender(<Probe desktop={false} />); fireEvent.click(screen.getByText("arm")); fireEvent.blur(screen.getByTestId("input")); expect(screen.getByTestId("active")).toHaveTextContent("true"); });
  });
});

// Folded from use-direct-typing-paste.test.tsx.
describe('use-direct-typing-paste.test', () => {
  let lastSend: ReturnType<typeof vi.fn>;
  function Probe({ desktop = true, image = false }: { desktop?: boolean; image?: boolean }) {
    const ref = useRef<HTMLTextAreaElement>(null);
    const sendRef = useRef(vi.fn(async () => true)); const send = sendRef.current; lastSend = send;
    const direct = useDirectTyping({ paneKey: "session\0p", inputRef: ref, replyDraft: () => "", canActivate: () => true, suspended: false, sendKeys: send, onActivate: vi.fn(), focusInput: () => ref.current?.focus(), desktop, uploadImage: image ? async () => "/host/shot.png" : undefined });
    return <><textarea ref={ref} onBlur={direct.onBlur} data-testid="input" /><button onClick={direct.activate}>arm</button></>;
  }
  function paste(text: string, items: unknown[] = []) { const event = new Event("paste", { bubbles: true, cancelable: true }); Object.defineProperty(event, "clipboardData", { value: { getData: () => text, items } }); act(() => screen.getByTestId("input").dispatchEvent(event)); return event; }
  afterEach(() => { cleanup(); __resetPasteHold(); });
  describe("desktop paste", () => {
    it("sends ordinary single-line text", async () => { render(<Probe />); fireEvent.click(screen.getByText("arm")); await new Promise((resolve) => setTimeout(resolve, 0)); expect(paste("echo hi").defaultPrevented).toBe(true); await waitFor(() => expect(lastSend).toHaveBeenCalledWith(["e", "c", "h", "o", "Space", "h", "i"])); expect(pasteHold()).toBeNull(); });
    it("holds a trailing-newline single command without sending Enter", () => { render(<Probe />); fireEvent.click(screen.getByText("arm")); paste("echo hi\n"); const hold = pasteHold(); expect(hold?.kind).toBe("text"); expect(hold?.kind === "text" ? hold.lines : null).toBe(1); act(() => hold?.onSend()); expect(lastSend.mock.calls[0][0]).toEqual(textToKeySequence("echo hi")); expect(lastSend.mock.calls[0][0]).not.toContain("Enter"); });
    it("holds multiline and sends interior Enter without trailing Enter", async () => { render(<Probe />); fireEvent.click(screen.getByText("arm")); paste("echo a\necho b\n"); expect(pasteHold()?.kind).toBe("text"); pasteHold()?.onSend(); expect(lastSend.mock.calls[0][0]).toContain("Enter"); expect(lastSend.mock.calls[0][0].at(-1)).not.toBe("Enter"); });
    it("holds destructive text with a destructive reason", () => { render(<Probe />); fireEvent.click(screen.getByText("arm")); paste("rm -rf /tmp/x"); const hold = pasteHold(); expect(hold?.kind).toBe("text"); expect(hold?.kind === "text" ? hold.reason : null).toMatch(/rm -r/); });
    it("holds destructive text and discards", async () => { render(<Probe />); fireEvent.click(screen.getByText("arm")); paste("rm -rf /tmp/x"); expect(pasteHold()?.kind).toBe("text"); pasteHold()?.onDiscard(); expect(pasteHold()).toBeNull(); expect(lastSend).not.toHaveBeenCalled(); });
    it("types an uploaded image path only after the chip is clicked", async () => { render(<Probe image />); fireEvent.click(screen.getByText("arm")); const file = new File(["x"], "shot.png", { type: "image/png" }); paste("", [{ kind: "file", type: "image/png", getAsFile: () => file }]); await vi.waitFor(() => expect(pasteHold()?.kind).toBe("path")); expect(lastSend).not.toHaveBeenCalled(); const hold = pasteHold(); act(() => hold?.onSend()); expect(lastSend).toHaveBeenCalledWith(textToKeySequence("/host/shot.png")); });
    it("holds image without typing until Type path", async () => { render(<Probe image />); fireEvent.click(screen.getByText("arm")); const file = new File(["x"], "shot.png", { type: "image/png" }); paste("", [{ kind: "file", type: "image/png", getAsFile: () => file }]); await vi.waitFor(() => expect(pasteHold()?.kind).toBe("path")); expect(lastSend).not.toHaveBeenCalled(); pasteHold()?.onSend(); expect(lastSend).toHaveBeenCalled(); });
    it("clears on blur", async () => { render(<Probe />); fireEvent.click(screen.getByText("arm")); paste("a\nb"); fireEvent.blur(screen.getByTestId("input")); expect(pasteHold()).toBeNull(); });
    it("does nothing on phone", async () => { render(<Probe desktop={false} />); fireEvent.click(screen.getByText("arm")); expect(paste("x").defaultPrevented).toBe(false); });
    it("does not hold or send a multiline paste on phone", () => { render(<Probe desktop={false} />); fireEvent.click(screen.getByText("arm")); paste("a\nb"); expect(pasteHold()).toBeNull(); expect(lastSend).not.toHaveBeenCalled(); });
  });
});
