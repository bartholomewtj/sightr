/**
 * Who runs a keybinding command (T13). The keybinding table (`keybindings.ts`) says which command a key
 * press means; this registry says what that command does right now. A mounted component registers a
 * handler (the composer owns `composer.sendAlternate`, the Terminal tab owns `terminal.directTyping`);
 * the newest registration runs first, and a handler that returns `false` passes the command on to the
 * one below it. `GlobalShortcuts` registers the app-wide defaults underneath everything.
 *
 * The palette's actions and the buttons call the same functions the handlers call, so a key, a palette
 * row and a button share one code path.
 */
import { useEffect, useRef } from "react";

import type { KeybindingCommand } from "@t3tools/contracts";
import { isDirectArmed } from "@v1/lib/direct-arm";

import type { ShortcutMatchContext } from "@/keybindings";

export type ShortcutHandler = (event: KeyboardEvent | null) => boolean | void;

const stacks = new Map<KeybindingCommand, ShortcutHandler[]>();

export function registerShortcutHandler(command: KeybindingCommand, handler: ShortcutHandler): () => void {
  const stack = stacks.get(command) ?? [];
  stack.push(handler);
  stacks.set(command, stack);
  return () => {
    const current = stacks.get(command);
    if (!current) return;
    const index = current.lastIndexOf(handler);
    if (index >= 0) current.splice(index, 1);
  };
}

/** Run `command`; true when a handler took it (the key press is then consumed). */
export function runShortcutCommand(command: KeybindingCommand, event: KeyboardEvent | null = null): boolean {
  const stack = stacks.get(command);
  if (!stack) return false;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const handler = stack[i];
    if (handler && handler(event) !== false) return true;
  }
  return false;
}

/** Register `handler` for `command` while mounted (and `enabled`). The latest closure always runs. */
export function useShortcutHandler(command: KeybindingCommand, handler: ShortcutHandler, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    return registerShortcutHandler(command, (event) => ref.current(event));
  }, [command, enabled]);
}

// ── Context ─────────────────────────────────────────────────────────────────────────────────────

/** True when keystrokes belong to a text field. */
export function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(el.type);
  if (el instanceof HTMLSelectElement) return true;
  return (el as HTMLElement).isContentEditable === true;
}

/** The parts of the `when` context the DOM answers; the shell adds the store-backed rest. */
export function domShortcutContext(doc: Document = document): Pick<ShortcutMatchContext, "terminalFocus" | "composerFocus" | "editableFocus"> {
  const active = doc.activeElement;
  return {
    terminalFocus: isDirectArmed() || (active instanceof Element && active.closest("[data-terminal-mirror]") !== null),
    composerFocus: active instanceof Element && active.matches("[data-composer-input]"),
    editableFocus: isTextEntry(active),
  };
}

/** Test helper. */
export function __resetShortcutHandlers(): void {
  stacks.clear();
}
