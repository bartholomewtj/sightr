import { describe, expect, it } from "vitest";

import { DEFAULT_KEYBINDINGS, parseKeybindingWhenExpression } from "@t3tools/shared/keybindings";

import { COMMAND_LABEL, evaluateWhenNode, formatShortcutLabel, KEYBINDINGS, matchBinding, shortcutLabelForCommand } from "./keybindings";

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

  it("does not take the browser's mod+w, mod+t or mod+d", () => {
    for (const k of ["w", "t", "d"]) expect(matchBinding(key(k, { ctrl: true }), {}, WIN)).toBeNull();
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
