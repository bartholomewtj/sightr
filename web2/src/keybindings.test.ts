import { describe, expect, it } from "vitest";

import { DEFAULT_KEYBINDINGS, parseKeybindingWhenExpression } from "@t3tools/shared/keybindings";

import {
  COMMAND_LABEL,
  evaluateWhenNode,
  formatShortcutLabel,
  KEYBINDINGS,
  matchBinding,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
} from "./keybindings";

const WIN = "Win32";
const MAC = "MacIntel";

function key(k: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}, code?: string) {
  return { key: k, code, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt };
}

describe("matchBinding", () => {
  it("maps mod to Ctrl on Windows and Cmd on Apple", () => {
    expect(matchBinding(key("k", { ctrl: true }), {}, WIN)).toBe("commandPalette.toggle");
    expect(matchBinding(key("k", { meta: true }), {}, WIN)).toBeNull();
    expect(matchBinding(key("k", { meta: true }), {}, MAC)).toBe("commandPalette.toggle");
    expect(matchBinding(key("k", { ctrl: true }), {}, MAC)).toBeNull();
    expect(matchBinding(key("k", { meta: true }), {}, "iPhone")).toBe("commandPalette.toggle");
  });

  it("turns off every !terminalFocus binding while direct typing is armed", () => {
    expect(matchBinding(key("k", { ctrl: true }), { terminalFocus: true }, WIN)).toBeNull();
    expect(matchBinding(key("n", { ctrl: true }), { terminalFocus: true }, WIN)).toBeNull();
    // No `when`: still applies; ctrl+` is never blocked.
    expect(matchBinding(key("b", { ctrl: true }), { terminalFocus: true }, WIN)).toBe("sidebar.toggle");
    expect(matchBinding(key("`", { ctrl: true }, "Backquote"), { terminalFocus: true, editableFocus: true }, WIN)).toBe(
      "terminal.directTyping",
    );
  });

  it("ignores mod+z in a text field and runs undo elsewhere", () => {
    expect(matchBinding(key("z", { ctrl: true }), { editableFocus: true }, WIN)).toBeNull();
    expect(matchBinding(key("z", { ctrl: true }), {}, WIN)).toBe("thread.undo");
  });

  it("ignores ? in a text field and opens the shortcuts sheet elsewhere, with the Shift the layout needs", () => {
    expect(matchBinding(key("?", { shift: true }, "Slash"), { editableFocus: true }, WIN)).toBeNull();
    expect(matchBinding(key("?", { shift: true }, "Slash"), {}, WIN)).toBe("shortcuts.open");
    expect(matchBinding(key("?", {}), {}, WIN)).toBe("shortcuts.open");
    // A real DOM event (its fields are getters, not own properties).
    expect(matchBinding(new KeyboardEvent("keydown", { key: "?", shiftKey: true, code: "Slash" }), {}, WIN)).toBe("shortcuts.open");
    const altGr = new KeyboardEvent("keydown", { key: "ArrowDown", ctrlKey: true, altKey: true });
    expect(matchBinding(altGr, {}, WIN)).toBe("thread.next");
  });

  it("sends the alternate follow-up only from the composer while a turn runs", () => {
    expect(matchBinding(key("Enter", { ctrl: true }), { composerFocus: true, turnRunning: true, editableFocus: true }, WIN)).toBe(
      "composer.sendAlternate",
    );
    expect(matchBinding(key("Enter", { ctrl: true }), { composerFocus: true, editableFocus: true }, WIN)).toBeNull();
    expect(matchBinding(key("Enter", { ctrl: true, shift: true }), { composerFocus: true }, WIN)).toBe("thread.steerQueuedMessage");
    expect(matchBinding(key("ArrowUp", { alt: true }), { composerFocus: true, editableFocus: true }, WIN)).toBe("thread.editQueuedMessage");
    expect(matchBinding(key("ArrowUp", { alt: true }), {}, WIN)).toBeNull();
  });

  it("binds chat.new to mod+n and mod+alt+n, and thread traversal to ctrl+alt+arrows", () => {
    expect(matchBinding(key("n", { ctrl: true }), {}, WIN)).toBe("chat.new");
    expect(matchBinding(key("n", { ctrl: true, alt: true }), {}, WIN)).toBe("chat.new");
    expect(matchBinding(key("ArrowDown", { ctrl: true, alt: true }), {}, MAC)).toBe("thread.next");
    expect(matchBinding(key("ArrowUp", { ctrl: true, alt: true }), {}, WIN)).toBe("thread.previous");
    // Windows reports Ctrl+Alt as AltGraph.
    const altGraph = { ...key("ArrowUp", { ctrl: true, alt: true }), getModifierState: () => true };
    expect(matchBinding(altGraph, {}, WIN)).toBe("thread.previous");
  });

  it("does not take the browser's mod+w or mod+t", () => {
    for (const k of ["w", "t"]) expect(matchBinding(key(k, { ctrl: true }), {}, WIN)).toBeNull();
  });

  it("maps mod+d to diff.toggle (T3's key, T27) unless direct typing is armed, so ctrl+d still reaches the terminal", () => {
    expect(matchBinding(key("d", { ctrl: true }), {}, WIN)).toBe("diff.toggle");
    expect(matchBinding(key("d", { meta: true }), {}, MAC)).toBe("diff.toggle");
    expect(matchBinding(key("d", { ctrl: true }), { editableFocus: true }, WIN)).toBe("diff.toggle");
    expect(matchBinding(key("d", { ctrl: true }), { terminalFocus: true }, WIN)).toBeNull();
    expect(matchBinding(key("d", { meta: true }), {}, WIN)).toBeNull();
    expect(COMMAND_LABEL["diff.toggle"]).toBe("Open the Diff tab");
  });
});

describe("when grammar", () => {
  const ctx = { a: true, b: false, c: true };
  const evalWhen = (expr: string) => {
    const ast = parseKeybindingWhenExpression(expr);
    if (!ast) throw new Error(`did not parse: ${expr}`);
    return evaluateWhenNode(ast, ctx);
  };

  it("supports and, or, not and parentheses", () => {
    expect(evalWhen("a && c")).toBe(true);
    expect(evalWhen("a && b")).toBe(false);
    expect(evalWhen("b || c")).toBe(true);
    expect(evalWhen("!b")).toBe(true);
    expect(evalWhen("!(a && b) && c")).toBe(true);
    expect(evalWhen("a && (b || !c)")).toBe(false);
  });

  it("treats an unknown key as false and refuses broken expressions", () => {
    expect(evalWhen("nope")).toBe(false);
    expect(evalWhen("!nope")).toBe(true);
    expect(parseKeybindingWhenExpression("a &&")).toBeNull();
    expect(parseKeybindingWhenExpression("(a")).toBeNull();
  });
});

describe("the default table", () => {
  it("compiles every rule and labels every command", () => {
    expect(KEYBINDINGS).toHaveLength(DEFAULT_KEYBINDINGS.length);
    for (const rule of DEFAULT_KEYBINDINGS) expect(COMMAND_LABEL[rule.command]).toBeTruthy();
  });

  it("formats labels per platform", () => {
    expect(shortcutLabelForCommand(KEYBINDINGS, "commandPalette.toggle", { platform: WIN })).toBe("Ctrl+K");
    expect(shortcutLabelForCommand(KEYBINDINGS, "commandPalette.toggle", { platform: MAC })).toBe("⌘K");
    const steer = KEYBINDINGS.find((b) => b.command === "thread.steerQueuedMessage")!;
    expect(formatShortcutLabel(steer.shortcut, WIN)).toBe("Ctrl+Shift+Enter");
  });
});

describe("thread jump (mod+1..9)", () => {
  it("maps mod+digit to the Nth jump command, by the digit's key or its physical code", () => {
    expect(matchBinding(key("1", { ctrl: true }), {}, WIN)).toBe("thread.jump.1");
    expect(matchBinding(key("9", { ctrl: true }), {}, WIN)).toBe("thread.jump.9");
    expect(matchBinding(key("3", { meta: true }), {}, MAC)).toBe("thread.jump.3");
    // A layout that types a symbol on the digit row still jumps by position.
    expect(matchBinding(key("&", { ctrl: true }, "Digit1"), {}, "Win32")).toBe("thread.jump.1");
    expect(matchBinding(key("1", { ctrl: true, shift: true }), {}, WIN)).toBeNull();
    expect(matchBinding(key("0", { ctrl: true }), {}, WIN)).toBeNull();
    expect(matchBinding(key("1", {}), {}, WIN)).toBeNull();
  });

  it("is off while direct typing is armed, but not in a text field", () => {
    expect(matchBinding(key("2", { ctrl: true }), { terminalFocus: true }, WIN)).toBeNull();
    expect(matchBinding(key("2", { ctrl: true }), { editableFocus: true }, WIN)).toBe("thread.jump.2");
  });

  it("converts between index and command", () => {
    expect(threadJumpCommandForIndex(0)).toBe("thread.jump.1");
    expect(threadJumpCommandForIndex(8)).toBe("thread.jump.9");
    expect(threadJumpCommandForIndex(9)).toBeNull();
    expect(threadJumpIndexFromCommand("thread.jump.4")).toBe(3);
    expect(threadJumpIndexFromCommand("thread.next")).toBeNull();
    expect(threadJumpIndexFromCommand(null)).toBeNull();
  });

  it("labels the first jump key per platform", () => {
    expect(shortcutLabelForCommand(KEYBINDINGS, "thread.jump.3", { platform: WIN })).toBe("Ctrl+3");
    expect(shortcutLabelForCommand(KEYBINDINGS, "thread.jump.3", { platform: MAC })).toBe("⌘3");
  });

  it("shows the hints for exactly the jump modifier, never while the terminal has the keys", () => {
    const mods = (m: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...m });
    expect(shouldShowThreadJumpHintsForModifiers(mods({ ctrlKey: true }), KEYBINDINGS, { platform: WIN })).toBe(true);
    expect(shouldShowThreadJumpHintsForModifiers(mods({ metaKey: true }), KEYBINDINGS, { platform: WIN })).toBe(false);
    expect(shouldShowThreadJumpHintsForModifiers(mods({ metaKey: true }), KEYBINDINGS, { platform: MAC })).toBe(true);
    expect(shouldShowThreadJumpHintsForModifiers(mods({ ctrlKey: true, shiftKey: true }), KEYBINDINGS, { platform: WIN })).toBe(false);
    expect(shouldShowThreadJumpHintsForModifiers(mods({}), KEYBINDINGS, { platform: WIN })).toBe(false);
    expect(shouldShowThreadJumpHintsForModifiers(mods({ ctrlKey: true }), KEYBINDINGS, { platform: WIN, context: { terminalFocus: true } })).toBe(false);
  });
});
