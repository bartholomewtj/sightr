// Adapted from T3 Code apps/web/src/keybindings.ts @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: Sightr's `when` context keys (T13); the platform is injectable for tests and read from
// `userAgentData` before `navigator.platform`; a binding with no modifier never fires while a text
// field has focus; a symbol key such as `?` matches whatever Shift the layout needs to type it. The
// terminal split, preview, thread-jump and model-picker helpers are not taken.
import type { KeybindingCommand, KeybindingShortcut, KeybindingWhenNode, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  isMacPlatform,
  matchesKeybindingShortcut,
  type ShortcutEventLike,
} from "@t3tools/shared/keybindings";

export type { ShortcutEventLike, ShortcutModifierStateLike } from "@t3tools/shared/keybindings";
export { shortcutKeyFromEvent } from "@t3tools/shared/keybindings";

/** The resolved default table (the keybindings are code in this slice: no overrides file). */
export const KEYBINDINGS: ResolvedKeybindingsConfig = DEFAULT_RESOLVED_KEYBINDINGS;

/**
 * The `when` keys the app sets (T13):
 * - `terminalFocus`: direct typing is armed, or focus is inside the terminal mirror;
 * - `composerFocus`: the composer's text box has focus;
 * - `turnRunning`: the open thread's agent is working;
 * - `rightPanelOpen`, `paletteOpen`;
 * - `editableFocus`: any text field has focus (T3's name; the spec calls it `textFieldFocus`).
 */
export interface ShortcutMatchContext {
  terminalFocus: boolean;
  composerFocus: boolean;
  turnRunning: boolean;
  rightPanelOpen: boolean;
  paletteOpen: boolean;
  editableFocus: boolean;
  [key: string]: boolean;
}

export interface ShortcutMatchOptions {
  platform?: string;
  context?: Partial<ShortcutMatchContext>;
}

/** The platform string `mod` is decided from: Cmd on Apple, Ctrl elsewhere. */
export function currentPlatform(): string {
  if (typeof navigator === "undefined") return "";
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return uaData?.platform || navigator.platform || "";
}

function resolvePlatform(options: ShortcutMatchOptions | undefined): string {
  return options?.platform ?? currentPlatform();
}

function resolveContext(options: ShortcutMatchOptions | undefined): ShortcutMatchContext {
  return {
    terminalFocus: false,
    composerFocus: false,
    turnRunning: false,
    rightPanelOpen: false,
    paletteOpen: false,
    editableFocus: false,
    ...options?.context,
  };
}

/** T3's evaluator: an unknown identifier is false. */
export function evaluateWhenNode(node: KeybindingWhenNode, context: Partial<ShortcutMatchContext>): boolean {
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return Boolean(context[node.name]);
    case "not":
      return !evaluateWhenNode(node.node, context);
    case "and":
      return evaluateWhenNode(node.left, context) && evaluateWhenNode(node.right, context);
    case "or":
      return evaluateWhenNode(node.left, context) || evaluateWhenNode(node.right, context);
  }
}

function matchesWhenClause(whenAst: KeybindingWhenNode | undefined, context: ShortcutMatchContext): boolean {
  if (!whenAst) return true;
  return evaluateWhenNode(whenAst, context);
}

/** No Ctrl, Cmd, Alt or mod: a key a text field types (Shift alone still types). */
export function isUnmodifiedShortcut(shortcut: KeybindingShortcut): boolean {
  return !shortcut.modKey && !shortcut.ctrlKey && !shortcut.metaKey && !shortcut.altKey;
}

/** A printable symbol (`?`, `/`): the layout decides whether Shift is needed, so ignore it. */
function isSymbolKey(key: string): boolean {
  return key.length === 1 && !/^[a-z0-9]$/i.test(key);
}

/** The event's fields as a plain object (a DOM event's are prototype getters, which a spread drops). */
function plainEvent(event: ShortcutEventLike, over: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: event.key,
    ...(event.code !== undefined ? { code: event.code } : {}),
    ...(event.type !== undefined ? { type: event.type } : {}),
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ...over,
  };
}

function matchesShortcut(event: ShortcutEventLike, shortcut: KeybindingShortcut, platform: string): boolean {
  if (matchesKeybindingShortcut(event, shortcut, platform)) return true;
  // Windows reports Ctrl+Alt as AltGraph, which T3's matcher refuses for non-letter keys. A binding
  // that itself asks for Ctrl+Alt (ctrl+alt+arrowup) means exactly those two keys.
  if (shortcut.altKey && (shortcut.ctrlKey || (shortcut.modKey && !isMacPlatform(platform))) && event.getModifierState) {
    if (matchesKeybindingShortcut(plainEvent(event), shortcut, platform)) return true;
  }
  if (!isSymbolKey(shortcut.key) || shortcut.shiftKey || event.key !== shortcut.key) return false;
  const altGraph = event.getModifierState?.("AltGraph");
  return matchesKeybindingShortcut(
    plainEvent(event, { shiftKey: false, ...(altGraph !== undefined ? { getModifierState: () => altGraph } : {}) }),
    shortcut,
    platform,
  );
}

export function shortcutConflictKey(shortcut: KeybindingShortcut, platform = currentPlatform()): string {
  const useMetaForMod = isMacPlatform(platform);
  const metaKey = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const ctrlKey = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return [shortcut.key, metaKey ? "meta" : "", ctrlKey ? "ctrl" : "", shortcut.shiftKey ? "shift" : "", shortcut.altKey ? "alt" : ""].join(
    "|",
  );
}

export function effectiveShortcutsForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): KeybindingShortcut[] {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);
  const claimedShortcuts = new Set<string>();
  const effective: KeybindingShortcut[] = [];

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;
    const conflictKey = shortcutConflictKey(binding.shortcut, platform);
    if (claimedShortcuts.has(conflictKey)) continue;
    claimedShortcuts.add(conflictKey);
    if (binding.command === command) effective.push(binding.shortcut);
  }
  return effective;
}

/**
 * The command a key press runs, or null. Later rules win (T3). A rule with no modifier never fires
 * while a text field has focus, whatever its `when` says.
 */
export function resolveShortcutCommand(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): KeybindingCommand | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (context.editableFocus && isUnmodifiedShortcut(binding.shortcut)) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;
    if (!matchesShortcut(event, binding.shortcut, platform)) continue;
    return binding.command;
  }
  return null;
}

/** Same as {@link resolveShortcutCommand} for the default table. */
export function matchBinding(event: ShortcutEventLike, context: Partial<ShortcutMatchContext>, platform?: string): KeybindingCommand | null {
  return resolveShortcutCommand(event, KEYBINDINGS, { context, ...(platform !== undefined ? { platform } : {}) });
}

export function formatShortcutKeyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (key === "escape") return "Esc";
  if (key === "arrowup") return "Up";
  if (key === "arrowdown") return "Down";
  if (key === "arrowleft") return "Left";
  if (key === "arrowright") return "Right";
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

export function formatShortcutLabel(shortcut: KeybindingShortcut, platform = currentPlatform()): string {
  const keyLabel = formatShortcutKeyLabel(shortcut.key);
  const useMetaForMod = isMacPlatform(platform);
  const showMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const showCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  const showAlt = shortcut.altKey;
  const showShift = shortcut.shiftKey;

  if (useMetaForMod) {
    return `${showCtrl ? "⌃" : ""}${showAlt ? "⌥" : ""}${showShift ? "⇧" : ""}${showMeta ? "⌘" : ""}${keyLabel}`;
  }

  const parts: string[] = [];
  if (showCtrl) parts.push("Ctrl");
  if (showAlt) parts.push("Alt");
  if (showShift) parts.push("Shift");
  if (showMeta) parts.push("Meta");
  parts.push(keyLabel);
  return parts.join("+");
}

/** The label of the first binding of `command` that applies in `options.context` (T3). */
export function shortcutLabelForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand | null,
  options?: string | ShortcutMatchOptions,
): string | null {
  if (command === null) return null;
  const resolved = typeof options === "string" ? { platform: options } : options;
  const shortcut = effectiveShortcutsForCommand(keybindings, command, resolved)[0];
  return shortcut ? formatShortcutLabel(shortcut, resolvePlatform(resolved)) : null;
}

export function threadTraversalDirectionFromCommand(command: string | null): "previous" | "next" | null {
  if (command === "thread.previous") return "previous";
  if (command === "thread.next") return "next";
  return null;
}

/** What the shortcuts sheet says each command does. */
export const COMMAND_LABEL: Record<KeybindingCommand, string> = {
  "sidebar.toggle": "Toggle the sidebar",
  "terminal.toggle": "Open the Terminal tab",
  "rightPanel.toggle": "Toggle the right panel",
  "rightPanel.files": "Open the Files tab",
  "rightPanel.git": "Open the Git tab",
  "terminal.directTyping": "Type into the terminal (on or off)",
  "commandPalette.toggle": "Command palette",
  "composer.sendAlternate": "Send the other way (queue or steer) while the agent works",
  "chat.new": "New thread",
  "chat.find": "Find in the timeline",
  "thread.stop": "Stop the run",
  "thread.steerQueuedMessage": "Steer with the oldest queued message",
  "thread.editQueuedMessage": "Edit the newest queued message",
  "thread.previous": "Previous thread",
  "thread.next": "Next thread",
  "thread.settle": "Settle the thread",
  "thread.pin": "Pin the thread",
  "thread.undo": "Undo the last sidebar change",
  "shortcuts.open": "Keyboard shortcuts",
};
