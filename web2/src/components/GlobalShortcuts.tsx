/**
 * The one keydown listener for the keybinding table (T13). It listens in the capture phase, so a table
 * binding is resolved before the focused element sees the key; when a handler takes the command, the
 * key is consumed. The `when` context is read at the moment of the press. It also registers the
 * app-wide default handlers, under whatever a mounted component registers.
 */
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import type { KeybindingCommand } from "@t3tools/contracts";

import { isCommandPaletteOpen, toggleCommandPalette } from "@/commandPaletteBus";
import { openShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { undoLatestThreadAction } from "@/hooks/showThreadUndoNotice";
import { DESKTOP_QUERY, useLayout } from "@/hooks/useLayout";
import { KEYBINDINGS, resolveShortcutCommand, type ShortcutMatchContext } from "@/keybindings";
import { adjacentThread } from "@/lib/threadNavigation";
import { selectRightPanelOpen, toggleRightPanelSurface, useRightPanelStore } from "@/rightPanelStore";
import { domShortcutContext, registerShortcutHandler, runShortcutCommand } from "@/shortcutHandlers";
import { useShell, useThreadStore } from "@/stream/stores";
import { useUiState } from "@/uiStateStore";

/** Commands that may repeat while the key is held. */
const REPEATABLE = new Set<KeybindingCommand>(["thread.previous", "thread.next"]);

export function GlobalShortcuts() {
  const navigate = useNavigate();
  const { threadId } = useParams({ strict: false }) as { threadId?: string };
  const desktop = useLayout() === "desktop";
  const live = useRef({ threadId, desktop });
  live.current = { threadId, desktop };

  // ── App-wide defaults ──
  useEffect(() => {
    const go = (to: string) => void navigate({ to });
    const openThread = (id: string) => void navigate({ to: "/thread/$threadId", params: { threadId: id } });
    const traverse = (direction: "previous" | "next") => {
      const { projects, threads } = useShell.getState();
      const next = adjacentThread(Object.values(projects), Object.values(threads), live.current.threadId ?? null, direction);
      if (next === null) return false;
      openThread(next);
      return true;
    };
    const offs = [
      registerShortcutHandler("commandPalette.toggle", () => toggleCommandPalette()),
      registerShortcutHandler("sidebar.toggle", () => {
        if (!live.current.desktop) return false;
        const ui = useUiState.getState();
        ui.setSidebarOpen(!ui.sidebarOpen);
      }),
      registerShortcutHandler("rightPanel.toggle", () => {
        const store = useRightPanelStore.getState();
        if (live.current.desktop) store.toggleVisibility();
        else if (store.sheet !== null) store.closeSheet();
        else if (live.current.threadId) store.openSheet(store.activeSurfaceId);
        else return false;
      }),
      registerShortcutHandler("terminal.toggle", () => {
        if (!live.current.desktop && !live.current.threadId) return false;
        toggleRightPanelSurface("terminal");
      }),
      registerShortcutHandler("rightPanel.files", () => toggleRightPanelSurface("files")),
      registerShortcutHandler("rightPanel.git", () => toggleRightPanelSurface("git")),
      // The Terminal tab registers its own handler while mounted; this one opens it and asks it to arm.
      registerShortcutHandler("terminal.directTyping", () => {
        const id = live.current.threadId;
        if (!id) return false;
        const store = useRightPanelStore.getState();
        if (live.current.desktop) store.open("terminal");
        else store.openSheet("terminal");
        store.requestDirectTyping(id);
      }),
      registerShortcutHandler("chat.new", () => go("/new")),
      // Find in the timeline is T19's; until then the browser's own find keeps the key.
      registerShortcutHandler("chat.find", () => false),
      registerShortcutHandler("thread.previous", () => traverse("previous")),
      registerShortcutHandler("thread.next", () => traverse("next")),
      registerShortcutHandler("thread.undo", () => undoLatestThreadAction()),
      registerShortcutHandler("shortcuts.open", () => openShortcutsDialog()),
    ];
    return () => offs.forEach((off) => off());
  }, [navigate]);

  return <ShortcutListener />;
}

/**
 * The capture-phase keydown listener alone (no router), so a component test can mount it beside the
 * component that registers handlers.
 */
export function ShortcutListener() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const command = resolveShortcutCommand(event, KEYBINDINGS, { context: currentShortcutContext() });
      if (command === null) return;
      if (event.repeat && !REPEATABLE.has(command)) return;
      if (!runShortcutCommand(command, event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  return null;
}

function isDesktopNow(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DESKTOP_QUERY).matches;
}

/** The full `when` context right now. `turnRunning` is about the open thread (the thread stream's). */
export function currentShortcutContext(): ShortcutMatchContext {
  const thread = useThreadStore.getState().current?.thread ?? null;
  return {
    ...domShortcutContext(),
    turnRunning: thread?.status === "working",
    rightPanelOpen: selectRightPanelOpen(useRightPanelStore.getState(), isDesktopNow()),
    paletteOpen: isCommandPaletteOpen(),
  };
}
