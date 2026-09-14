import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectTypingStrip } from "./direct-typing-strip";
import { __resetPasteHold, setPasteHold } from "@/lib/paste-hold";

// Folded from direct-typing-strip.test.tsx.
describe('direct-typing-strip.test', () => {
  describe("DirectTypingStrip", () => {
    it("shows the active state and stops", () => { const stop = vi.fn(); render(<DirectTypingStrip onStop={stop} />); expect(screen.getByText("Typing into terminal")).toBeInTheDocument(); expect(screen.getByText(/keys go straight through/)).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Stop" })); expect(stop).toHaveBeenCalledOnce(); });
    it("shows a reason without a stop control when disabled", () => { render(<DirectTypingStrip onStop={vi.fn()} disabled reason="pane is gone" />); expect(screen.getByText(/pane is gone/)).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Stop" })).toBeNull(); });
  });
});

// Folded from direct-typing-strip-paste.test.tsx.
describe('direct-typing-strip-paste.test', () => {
  afterEach(__resetPasteHold);
  describe("paste hold strip", () => {
    it("prevents Send pointerdown so focus remains in the textarea", () => { setPasteHold({kind:"text",lines:1,reason:null,onSend:vi.fn(),onDiscard:vi.fn()}); render(<><textarea data-testid="input" /><DirectTypingStrip onStop={vi.fn()}/></>); const input = screen.getByTestId("input"); input.focus(); const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true }); screen.getByRole("button",{name:"Send"}).dispatchEvent(event); expect(event.defaultPrevented).toBe(true); expect(document.activeElement).toBe(input); });
    it("renders text actions and hides Stop", () => { const send=vi.fn(), discard=vi.fn(); setPasteHold({kind:"text",lines:2,reason:null,onSend:send,onDiscard:discard}); render(<DirectTypingStrip onStop={vi.fn()}/>); expect(screen.getByText(/Paste 2 lines/)).toBeInTheDocument(); fireEvent.click(screen.getByRole("button",{name:"Send"})); fireEvent.click(screen.getByRole("button",{name:"Discard"})); expect(send).toHaveBeenCalled(); expect(discard).toHaveBeenCalled(); expect(screen.queryByRole("button",{name:"Stop"})).toBeNull(); });
    it("renders singular, reason and path controls", () => { setPasteHold({kind:"text",lines:1,reason:"rm -rf",onSend:vi.fn(),onDiscard:vi.fn()}); const {rerender}=render(<DirectTypingStrip onStop={vi.fn()}/>); expect(screen.getByText(/Paste 1 line/)).toBeInTheDocument(); expect(screen.getByText(/rm -rf/)).toBeInTheDocument(); setPasteHold({kind:"path",path:"/host/a.png",onSend:vi.fn(),onDiscard:vi.fn()}); rerender(<DirectTypingStrip onStop={vi.fn()}/>); expect(screen.getByRole("button",{name:"Type path"})).toBeInTheDocument(); });
    it("supports Type path and suppresses holds when disabled", () => { const send=vi.fn(); setPasteHold({kind:"path",path:"/x",onSend:send,onDiscard:vi.fn()}); render(<DirectTypingStrip onStop={vi.fn()}/>); fireEvent.click(screen.getByRole("button",{name:"Type path"})); expect(send).toHaveBeenCalledOnce(); setPasteHold({kind:"text",lines:2,reason:null,onSend:vi.fn(),onDiscard:vi.fn()}); expect(send).toHaveBeenCalledOnce(); });
    it("suppresses holds when disabled", () => { setPasteHold({kind:"text",lines:2,reason:null,onSend:vi.fn(),onDiscard:vi.fn()}); render(<DirectTypingStrip onStop={vi.fn()} disabled reason="pane is gone"/>); expect(screen.queryByRole("button",{name:"Send"})).toBeNull(); });
  });
});
