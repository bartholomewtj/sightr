import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ComposerMenu } from "./composer-menu";
import type { ComposerMenuProps } from "./composer-menu";
import { __resetDesktop, setDesktop } from "@/lib/desktop";

// The + at the left edge of the reply field and the menu behind it. These pin the menu's shape
// (which rows, in which order, on which layout) and the two things that make it safe to put the
// controls behind a tap: every choice closes the menu, and the + goes inert while direct typing is
// armed (the typing strip's Stop is the one way out of that mode). The menu is input only: display
// prefs live in Settings and the pane menu.

beforeEach(() => __resetDesktop());
afterEach(() => {
  cleanup();
  __resetDesktop();
});

function mount(overrides: Partial<ComposerMenuProps> = {}) {
  const props: ComposerMenuProps = {
    locked: false,
    uploading: false,
    direct: { active: false, disabled: false, onStart: vi.fn() },
    hasCommands: true,
    onAttach: vi.fn(),
    onDrawer: vi.fn(),
    ...overrides,
  };
  render(
    <div className="relative">
      <ComposerMenu {...props} />
    </div>,
  );
  return props;
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  return screen.getByRole("dialog", { name: "More" });
}

/** The rows in DOM order, by accessible label. */
function rowLabels(dialog: HTMLElement): string[] {
  return Array.from(dialog.querySelectorAll('button[type="button"]'))
    .map((b) => b.textContent?.trim() ?? "")
    .filter((t) => t !== "");
}

describe("ComposerMenu — rows", () => {
  it("lists the four input rows in order on a phone", () => {
    mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    const dialog = open();
    expect(rowLabels(dialog)).toEqual([
      "Attach file",
      "Keys",
      "Agent commands",
      "Type into terminal",
    ]);
    // A bottom sheet on the phone, not a popover.
    expect(screen.queryByTestId("action-popover")).toBeNull();
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("drops Agent commands when the agent has none", () => {
    mount({ hasCommands: false });
    const dialog = open();
    expect(rowLabels(dialog)).toEqual(["Attach file", "Keys", "Type into terminal"]);
  });

  it("drops Keys and Type on desktop and opens as a popover", () => {
    setDesktop(true);
    mount();
    const dialog = open();
    expect(rowLabels(dialog)).toEqual(["Attach file", "Agent commands"]);
    expect(screen.getByTestId("action-popover")).toBe(dialog);
  });

  it("disables every row when locked", () => {
    mount({ locked: true });
    open();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keys" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Agent commands" })).toBeDisabled();
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Display" })).toBeNull();
  });
});

describe("ComposerMenu — choices", () => {
  it.each([
    ["Attach file", (p: ComposerMenuProps) => expect(p.onAttach).toHaveBeenCalledTimes(1)],
    ["Keys", (p: ComposerMenuProps) => expect(p.onDrawer).toHaveBeenCalledWith("keys")],
    ["Agent commands", (p: ComposerMenuProps) => expect(p.onDrawer).toHaveBeenCalledWith("cmd")],
  ])("%s fires its action and closes the menu", (label, check) => {
    const props = mount();
    open();
    fireEvent.click(screen.getByRole("button", { name: label }));
    check(props);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Type closes any dock first, then arms, then closes the menu", () => {
    const calls: string[] = [];
    mount({
      direct: { active: false, disabled: false, onStart: () => calls.push("start") },
      onDrawer: (next) => calls.push(`drawer:${String(next)}`),
    });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Type into terminal" }));
    expect(calls).toEqual(["drawer:null", "start"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Type is disabled while the composer is busy", () => {
    mount({ direct: { active: false, disabled: true, onStart: vi.fn() } });
    open();
    expect(screen.getByRole("button", { name: "Type into terminal" })).toBeDisabled();
  });
});

describe("ComposerMenu — while direct typing is armed", () => {
  it("the + stays More but is disabled, so there is no menu to open and no second Stop", () => {
    const props = mount({ direct: { active: true, disabled: false, onStart: vi.fn() } });
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop typing into terminal" })).toBeNull();
    fireEvent.click(more);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(props.direct.onStart).not.toHaveBeenCalled();
  });
});

describe("ComposerMenu — dismiss", () => {
  it("closes on Escape and on the sheet's Close without firing anything", () => {
    const props = mount();
    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(props.onAttach).not.toHaveBeenCalled();
    expect(props.onDrawer).not.toHaveBeenCalled();
  });
});

describe("ComposerMenu — phone sheet fits 390×844 (#367)", () => {
  const origInnerWidth = window.innerWidth;
  const origInnerHeight = window.innerHeight;
  const origVisualViewport = window.visualViewport;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: origInnerWidth, writable: true });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: origInnerHeight, writable: true });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: origVisualViewport, writable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: origInnerWidth, writable: true });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: origInnerHeight, writable: true });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: origVisualViewport, writable: true });
  });

  it("rows are on screen from the first frame: fades in place and maxHeight is capped to 828px", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390, writable: true });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844, writable: true });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined, writable: true });

    mount();
    const dialog = open();
    const panel = dialog.querySelector("div[tabindex='-1']") as HTMLElement;

    expect(panel).not.toHaveClass("slide-in-from-bottom");
    expect(panel).toHaveClass("fade-in");
    expect(panel.style.maxHeight).toBe("828px");
    expect(panel.style.bottom).toBe("");

    const attach = screen.getByRole("button", { name: "Attach file" });
    const keys = screen.getByRole("button", { name: "Keys" });
    const commands = screen.getByRole("button", { name: "Agent commands" });
    const type = screen.getByRole("button", { name: "Type into terminal" });

    expect(panel.contains(attach)).toBe(true);
    expect(panel.contains(keys)).toBe(true);
    expect(panel.contains(commands)).toBe(true);
    expect(panel.contains(type)).toBe(true);
  });

  it("keyboard up: the sheet sits on the visible viewport and adjusts on resize", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844, writable: true });

    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    const addEventListener = vi.fn((event: string, cb: (...args: any[]) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    });
    const removeEventListener = vi.fn((event: string, cb: (...args: any[]) => void) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((l) => l !== cb);
      }
    });

    const vvStub = {
      height: 500,
      offsetTop: 0,
      addEventListener,
      removeEventListener,
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vvStub, writable: true });

    mount();
    const dialog = open();
    const panel = dialog.querySelector("div[tabindex='-1']") as HTMLElement;

    expect(panel.style.maxHeight).toBe("484px");
    expect(panel.style.bottom).toBe("344px");

    // Keyboard dismissed: visual viewport expands to 844
    vvStub.height = 844;
    act(() => {
      listeners["resize"]?.forEach((cb) => cb());
    });

    expect(panel.style.maxHeight).toBe("828px");
    expect(panel.style.bottom).toBe("");

    // Close the sheet
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(removeEventListener).toHaveBeenCalled();
  });

  it("the last row still fires from the capped sheet", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390, writable: true });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844, writable: true });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined, writable: true });

    const props = mount();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Type into terminal" }));

    expect(props.direct.onStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("desktop popover still opens above the +", () => {
    setDesktop(true);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844, writable: true });

    mount({ hasCommands: true });
    const moreBtn = screen.getByRole("button", { name: "More" });
    vi.spyOn(moreBtn, "getBoundingClientRect").mockReturnValue({
      left: 20,
      top: 800,
      right: 56,
      bottom: 836,
      width: 36,
      height: 36,
      x: 20,
      y: 800,
      toJSON: () => {},
    });

    fireEvent.click(moreBtn);

    const popover = screen.getByTestId("action-popover");
    const top = parseFloat(popover.style.top);
    expect(top).toBeLessThan(800);
    // Two rows on desktop (Attach file, Agent commands): 800 - (2 x 40 + 48).
    expect(top).toBe(672);
    expect(popover.style.maxHeight).toBe("");
    expect(document.querySelector(".fade-in")).toBeNull();
    expect(document.querySelector(".slide-in-from-bottom")).toBeNull();
  });
});
