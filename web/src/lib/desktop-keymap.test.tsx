import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";

import { handleDesktopKeyDown, isAltKeyUp } from "@/lib/desktop-keymap";
import { useDirectTyping } from "@/hooks/use-direct-typing";

function ev(init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
  return new KeyboardEvent("keydown", { cancelable: true, ...init });
}

describe("desktop keydown mapper", () => {
  it.each([
    ["plain char", { key: "a" }, { kind: "ignore" }, false],
    ["Enter", { key: "Enter" }, { kind: "send", keys: ["Enter"] }, true],
    ["Backspace", { key: "Backspace" }, { kind: "send", keys: ["Backspace"] }, true],
    ["Tab", { key: "Tab" }, { kind: "send", keys: ["Tab"] }, true],
    ["Shift+Tab", { key: "Tab", shiftKey: true }, { kind: "send", keys: ["shift+Tab"] }, true],
    ["Ctrl+C without selection", { key: "c", ctrlKey: true }, { kind: "send", keys: ["ctrl+c"] }, true, (): boolean => false],
    ["Ctrl+C with selection", { key: "c", ctrlKey: true }, { kind: "ignore" }, false, (): boolean => true],
    ["Ctrl+C with default selection getter", { key: "c", ctrlKey: true }, { kind: "send", keys: ["ctrl+c"] }, true],
    ["Ctrl+V", { key: "v", ctrlKey: true }, { kind: "ignore" }, false],
    ["Ctrl+Shift+V", { key: "v", ctrlKey: true, shiftKey: true }, { kind: "ignore" }, false],
    ["Cmd+V", { key: "v", metaKey: true }, { kind: "ignore" }, false],
    ["Shift+Insert", { key: "Insert", shiftKey: true }, { kind: "ignore" }, false],
    ["Ctrl+Shift+P", { key: "P", ctrlKey: true, shiftKey: true }, { kind: "send", keys: ["ctrl+shift+p"] }, true],
    ["Ctrl+Space", { key: " ", ctrlKey: true }, { kind: "send", keys: ["ctrl+Space"] }, true],
    ["Ctrl+[", { key: "[", ctrlKey: true }, { kind: "send", keys: ["ctrl+["] }, true],
    ["AltGr+Q", { key: "@", ctrlKey: true, altKey: true }, { kind: "ignore" }, false],
    ["composing Enter", { key: "Enter", isComposing: true }, { kind: "ignore" }, false],
    ["F5", { key: "F5" }, { kind: "ignore" }, false],
    ["Delete", { key: "Delete" }, { kind: "ignore", notice: { text: "Herdr can't send Delete", tone: "warn" } }, false],
    ["Ctrl+D", { key: "d", ctrlKey: true }, { kind: "send", keys: ["ctrl+d"], notice: { text: "Sent Ctrl+D — this can close the shell.", tone: "info" } }, true],
    ["Ctrl+Z", { key: "z", ctrlKey: true }, { kind: "send", keys: ["ctrl+z"] }, true],
    ["keyCode 229", { key: "Process", keyCode: 229 }, { kind: "ignore" }, false],
    ["AltGr modifier state", { key: "@", modifierAltGraph: true }, { kind: "ignore" }, false],
    ["bare Alt", { key: "Alt", altKey: true }, { kind: "swallow" }, true],
    ["Ctrl+R", { key: "r", ctrlKey: true }, { kind: "ignore" }, false],
    ["Ctrl+Shift+R", { key: "r", ctrlKey: true, shiftKey: true }, { kind: "ignore" }, false],
    ["Ctrl+`", { key: "`", ctrlKey: true }, { kind: "ignore" }, false],
    ["Ctrl+Alt+Up", { key: "ArrowUp", ctrlKey: true, altKey: true }, { kind: "ignore" }, false],
    ["Ctrl+Alt+Down", { key: "ArrowDown", ctrlKey: true, altKey: true }, { kind: "ignore" }, false],
    ["Escape", { key: "Escape" }, { kind: "send", keys: ["Escape"] }, true],
    ["ArrowUp", { key: "ArrowUp" }, { kind: "send", keys: ["Up"] }, true],
    ["Space", { key: " " }, { kind: "send", keys: ["Space"] }, true],
    ["F1", { key: "F1" }, { kind: "send", keys: ["F1"] }, true],
    ["F12", { key: "F12" }, { kind: "send", keys: ["F12"] }, true],
    ["digit", { key: "5" }, { kind: "ignore" }, false],
    ["Cmd+K", { key: "k", metaKey: true }, { kind: "send", keys: ["cmd+k"] }, true],
    ["Cmd+Shift+P", { key: "P", metaKey: true, shiftKey: true }, { kind: "send", keys: ["cmd+shift+p"] }, true],
    ["Home", { key: "Home" }, { kind: "ignore", notice: { text: "Herdr can't send Home", tone: "warn" } }, false],
    ["End", { key: "End" }, { kind: "ignore", notice: { text: "Herdr can't send End", tone: "warn" } }, false],
    ["PageUp", { key: "PageUp" }, { kind: "ignore", notice: { text: "Herdr can't send PageUp", tone: "warn" } }, false],
    ["PageDown", { key: "PageDown" }, { kind: "ignore", notice: { text: "Herdr can't send PageDown", tone: "warn" } }, false],
    ["Insert", { key: "Insert" }, { kind: "ignore", notice: { text: "Herdr can't send Insert", tone: "warn" } }, false],
    ["Ctrl++", { key: "+", ctrlKey: true }, { kind: "ignore", notice: { text: "Herdr can't send +", tone: "warn" } }, false],
  ] as const)("%s", (...args: unknown[]) => {
    const [, init, expected, prevented, selection] = args as [string, KeyboardEventInit & { keyCode?: number }, unknown, boolean, (() => boolean) | undefined];
    const event = ev(init);
    expect(handleDesktopKeyDown(event, selection ? { hasSelection: selection } : undefined)).toEqual(expected);
    expect(event.defaultPrevented).toBe(prevented);
  });

  it("detects the bare Alt keyup", () => {
    expect(isAltKeyUp(new KeyboardEvent("keyup", { key: "Alt" }))).toBe(true);
  });

  it("keeps the phone keydown path separate from the desktop mapper", () => {
    const sendKeys = vi.fn(async () => true);
    function Probe({ desktop }: { desktop: boolean }) {
      const input = useRef<HTMLTextAreaElement>(null);
      const direct = useDirectTyping({
        paneKey: "p",
        inputRef: input,
        replyDraft: () => "",
        canActivate: () => true,
        suspended: false,
        sendKeys,
        onActivate: vi.fn(),
        focusInput: () => input.current?.focus(),
        desktop,
      });
      return <><textarea ref={input} data-testid="input" onKeyDown={direct.onKeyDown} onBlur={direct.onBlur} /><button onClick={direct.activate}>arm</button></>;
    }

    const { rerender } = render(<Probe desktop={false} />);
    fireEvent.click(screen.getByText("arm"));
    fireEvent.keyDown(screen.getByTestId("input"), { key: "c", ctrlKey: true });
    expect(sendKeys).not.toHaveBeenCalled();
    rerender(<Probe desktop />);
    fireEvent.click(screen.getByText("arm"));
    fireEvent.keyDown(screen.getByTestId("input"), { key: "c", ctrlKey: true });
    expect(sendKeys).toHaveBeenCalledWith(["ctrl+c"]);
    sendKeys.mockClear();
    fireEvent.keyDown(screen.getByTestId("input"), { key: "v", ctrlKey: true });
    expect(sendKeys).not.toHaveBeenCalled();
  });
});
