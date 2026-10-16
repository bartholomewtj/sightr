// Adapted from T3 Code packages/contracts/src/keybindings.ts @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: plain TypeScript types in place of Effect Schema (web2 does not take Effect); the command
// list is Sightr's (T13): T3's names where the job is the same, plus Sightr's right-panel tabs, the
// direct-typing toggle and the shortcuts sheet. The `when` AST, shortcut and resolved-rule shapes and
// the limits are T3's.

export const MAX_KEYBINDING_VALUE_LENGTH = 64;
export const MAX_WHEN_EXPRESSION_DEPTH = 64;
export const MAX_KEYBINDINGS_COUNT = 256;

// Not taken: T3's thread-jump (mod+1..9) and model-picker commands.

const THREAD_KEYBINDING_COMMANDS = [
  "thread.stop",
  "thread.steerQueuedMessage",
  "thread.editQueuedMessage",
  "thread.previous",
  "thread.next",
  "thread.settle",
  "thread.pin",
  "thread.undo",
] as const;
export type ThreadKeybindingCommand = (typeof THREAD_KEYBINDING_COMMANDS)[number];

export const STATIC_KEYBINDING_COMMANDS = [
  "sidebar.toggle",
  "terminal.toggle",
  "rightPanel.toggle",
  "commandPalette.toggle",
  "composer.sendAlternate",
  "chat.new",
  "chat.find",
  // Sightr: the right panel's fixed tabs, direct typing, the shortcuts sheet.
  "rightPanel.files",
  "rightPanel.git",
  "terminal.directTyping",
  "shortcuts.open",
  ...THREAD_KEYBINDING_COMMANDS,
] as const;

export type KeybindingCommand = (typeof STATIC_KEYBINDING_COMMANDS)[number];

export interface KeybindingRule {
  readonly key: string;
  readonly command: KeybindingCommand;
  readonly when?: string;
}

export type KeybindingsConfig = ReadonlyArray<KeybindingRule>;

export interface KeybindingShortcut {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly modKey: boolean;
}

export type KeybindingWhenNode =
  | { type: "identifier"; name: string }
  | { type: "not"; node: KeybindingWhenNode }
  | { type: "and"; left: KeybindingWhenNode; right: KeybindingWhenNode }
  | { type: "or"; left: KeybindingWhenNode; right: KeybindingWhenNode };

export interface ResolvedKeybindingRule {
  readonly command: KeybindingCommand;
  readonly shortcut: KeybindingShortcut;
  readonly whenAst?: KeybindingWhenNode;
}

export type ResolvedKeybindingsConfig = ReadonlyArray<ResolvedKeybindingRule>;
