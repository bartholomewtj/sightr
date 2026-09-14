import { useEffect, useRef, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router";
import { triage } from "@/lib/triage";
import { panePath } from "@/lib/nav";
import { desktopPrefs, setTyping } from "@/lib/desktop";
import { isDirectArmed, requestArmToggle } from "@/lib/direct-arm";
import { requestFindOpen } from "@/lib/find-request";
import { FILES_FIND_ID, sidebarSlot } from "@/components/desktop-sidebar-slot";
import type { AgentView } from "@/lib/types";

export interface DesktopHotkeyBinding {
  id: "shortcuts" | "direct" | "find" | "cyclePrev" | "cycleNext";
  label: string;
  keys: readonly string[];
  matches: (event: KeyboardEvent) => boolean;
}

const noMods = (key: string) => (event: KeyboardEvent) =>
  event.key === key && !event.ctrlKey && !event.altKey && !event.metaKey;
const ctrl = (key: string) => (event: KeyboardEvent) =>
  event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === key;
const ctrlAlt = (key: string) => (event: KeyboardEvent) =>
  event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey && event.key === key;

export const DESKTOP_HOTKEYS: readonly DesktopHotkeyBinding[] = [
  { id: "shortcuts", label: "Show keyboard shortcuts", keys: ["?"], matches: noMods("?") },
  { id: "direct", label: "Toggle direct typing", keys: ["Ctrl", "`"], matches: ctrl("`") },
  { id: "find", label: "Find in the current pane", keys: ["Ctrl", "F"], matches: ctrl("f") },
  { id: "cyclePrev", label: "Move to the previous pane", keys: ["Ctrl", "Alt", "↑"], matches: ctrlAlt("ArrowUp") },
  { id: "cycleNext", label: "Move to the next pane", keys: ["Ctrl", "Alt", "↓"], matches: ctrlAlt("ArrowDown") },
];

let shortcutsOpen = false;
const shortcutListeners = new Set<() => void>();
export function isShortcutsOpen() { return shortcutsOpen; }
export function openShortcuts() {
  if (shortcutsOpen) return;
  shortcutsOpen = true;
  shortcutListeners.forEach((listener) => listener());
}
export function closeShortcuts() {
  if (!shortcutsOpen) return;
  shortcutsOpen = false;
  shortcutListeners.forEach((listener) => listener());
}
export function useShortcutsOpen() {
  return useSyncExternalStore(
    (listener) => { shortcutListeners.add(listener); return () => shortcutListeners.delete(listener); },
    isShortcutsOpen,
    () => false,
  );
}

export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export interface DesktopHotkeyArgs {
  agents: readonly AgentView[];
  currentPaneId?: string;
}

export function useDesktopHotkeys({ agents, currentPaneId }: DesktopHotkeyArgs): void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const latest = useRef({ agents, currentPaneId, pathname });
  latest.current = { agents, currentPaneId, pathname };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const binding = DESKTOP_HOTKEYS.find((candidate) => candidate.matches(event));
      if (!binding) return;
      if (binding.id === "shortcuts") {
        if (isDirectArmed() || isTypingTarget(event.target)) return;
        event.preventDefault();
        openShortcuts();
        return;
      }

      const route = sidebarSlot(latest.current.pathname);
      switch (binding.id) {
        case "direct":
          if (route === "files") return;
          event.preventDefault();
          if (desktopPrefs().typing === "composer") setTyping("direct");
          requestArmToggle();
          return;
        case "find":
          if (isDirectArmed()) return;
          if (route === "files") {
            const input = document.getElementById(FILES_FIND_ID);
            if (!input) return;
            event.preventDefault();
            (input as HTMLInputElement).focus();
            (input as HTMLInputElement).select();
            return;
          }
          if (latest.current.currentPaneId === undefined) return;
          event.preventDefault();
          requestFindOpen();
          return;
        case "cyclePrev":
        case "cycleNext": {
          const { agents: currentAgents, currentPaneId: current } = latest.current;
          const ordered = triage(currentAgents).flatMap((section) => section.agents);
          if (ordered.length === 0) return;
          const index = ordered.findIndex((agent) => agent.paneId === current);
          const delta = binding.id === "cycleNext" ? 1 : -1;
          const nextIndex = index < 0 ? (delta > 0 ? 0 : ordered.length - 1) : (index + delta + ordered.length) % ordered.length;
          const next = ordered[nextIndex];
          if (!next || next.paneId === current) return;
          event.preventDefault();
          navigate(panePath(next.paneId));
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [navigate]);
}
