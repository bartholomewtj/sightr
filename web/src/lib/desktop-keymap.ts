import { composeKey, type Modifier } from "@/lib/key-queue";

type KeyNotice = { text: string; tone: "info" | "warn" };

type KeyAction =
  | { kind: "ignore"; notice?: KeyNotice }
  | { kind: "swallow" }
  | { kind: "send"; keys: string[]; notice?: KeyNotice };

interface KeyMapContext {
  hasSelection?: () => boolean;
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  Escape: "Escape",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  " ": "Space",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
};

const UNSUPPORTED_KEYS = new Set(["Home", "End", "PageUp", "PageDown", "Insert", "Delete"]);

function hasSelection(ctx?: KeyMapContext): boolean {
  if (ctx?.hasSelection) return ctx.hasSelection();
  try {
    const selection = window.getSelection();
    return selection !== null && !selection.isCollapsed;
  } catch {
    return false;
  }
}

function isGlobalChord(event: KeyboardEvent): boolean {
  if (event.key === "`" && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
    return true;
  }
  return (
    (event.key === "ArrowUp" || event.key === "ArrowDown") &&
    event.ctrlKey &&
    event.altKey
  );
}

/** Decide what a captured desktop keydown means without applying browser side effects. */
function mapKeyDown(event: KeyboardEvent, ctx?: KeyMapContext): KeyAction {
  if (event.isComposing || event.keyCode === 229) return { kind: "ignore" };
  if (isGlobalChord(event)) return { kind: "ignore" };

  const lowerKey = event.key.toLowerCase();
  if (event.key === "F5" || (event.ctrlKey && !event.altKey && !event.metaKey && lowerKey === "r")) {
    return { kind: "ignore" };
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    (event.key === "c" || event.key === "C") &&
    hasSelection(ctx)
  ) {
    return { kind: "ignore" };
  }
  // Let the browser fire a paste event so the desktop paste handler can hold
  // multiline / destructive text. Sending ctrl+v lets the host shell paste instead.
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    (event.key === "v" || event.key === "V")
  ) {
    return { kind: "ignore" };
  }
  if (event.key === "Insert" && event.shiftKey) {
    return { kind: "ignore" };
  }

  const altGraph =
    (event.ctrlKey && event.altKey) || event.getModifierState?.("AltGraph") === true;
  const ctrl = altGraph ? false : event.ctrlKey;
  const alt = altGraph ? false : event.altKey;

  if (event.key === "Alt") return { kind: "swallow" };
  if (event.key === "Control" || event.key === "Shift" || event.key === "Meta" || event.key === "AltGraph") {
    return { kind: "ignore" };
  }
  if (UNSUPPORTED_KEYS.has(event.key)) {
    return { kind: "ignore", notice: { text: `Herdr can't send ${event.key}`, tone: "warn" } };
  }

  const named = NAMED_KEYS[event.key];
  const printable = named === undefined && event.key.length === 1;
  const base = named ?? (printable ? event.key.toLowerCase() : undefined);
  if (base === undefined) return { kind: "ignore" };

  const modifiers: Modifier[] = [];
  if (ctrl) modifiers.push("ctrl");
  if (alt) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");

  if (!ctrl && !alt && !event.metaKey) {
    if (printable) return { kind: "ignore" };
    return { kind: "send", keys: [composeKey(modifiers, base)] };
  }
  if (base === "+") {
    return { kind: "ignore", notice: { text: "Herdr can't send +", tone: "warn" } };
  }

  let wire = composeKey(modifiers, base);
  if (event.metaKey) wire = `cmd+${wire}`;
  const notice = ctrl && base === "d"
    ? { text: "Sent Ctrl+D — this can close the shell.", tone: "info" as const }
    : undefined;
  return { kind: "send", keys: [wire], ...(notice ? { notice } : {}) };
}

/** Apply the mapper's only side effect: sent and swallowed keys are prevented. */
export function handleDesktopKeyDown(event: KeyboardEvent, ctx?: KeyMapContext): KeyAction {
  const action = mapKeyDown(event, ctx);
  if (action.kind === "send" || action.kind === "swallow") event.preventDefault();
  return action;
}

export function isAltKeyUp(event: KeyboardEvent): boolean {
  return event.key === "Alt";
}
