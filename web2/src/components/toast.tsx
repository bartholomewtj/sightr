/**
 * The toast stack: the one undo notice (hooks/showThreadUndoNotice.ts) and short plain messages
 * ("Pick a snooze time from the menu", a refused command). Mounted once in the root layout, so a toast
 * outlives the route that raised it (on a phone the sidebar unmounts when a thread opens).
 *
 * The stack sits above the bottom safe area and, when a thread's composer is on screen, above the
 * composer, so a toast never covers Send. A tap dismisses a message toast.
 */
import { useLayoutEffect, useState } from "react";
import { create } from "zustand";

import { SidebarThreadUndoNotice } from "@/components/sidebar/SidebarThreadUndoNotice";
import { useThreadUndoNotice } from "@/hooks/showThreadUndoNotice";

export const MESSAGE_TOAST_MS = 4_000;

export interface MessageToast {
  id: number;
  text: string;
  tone: "info" | "error";
}

export const useMessageToasts = create<{ toasts: MessageToast[] }>(() => ({ toasts: [] }));

let nextId = 1;

export function showToast(text: string, tone: MessageToast["tone"] = "info"): number {
  const toast = { id: nextId++, text, tone };
  // Three at most; the oldest goes first.
  useMessageToasts.setState((s) => ({ toasts: [...s.toasts.slice(-2), toast] }));
  setTimeout(() => dismissToast(toast.id), MESSAGE_TOAST_MS);
  return toast.id;
}

export function dismissToast(id: number): void {
  useMessageToasts.setState((s) => (s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : s));
}

export function __resetToasts(): void {
  useMessageToasts.setState({ toasts: [] });
}

/**
 * How far the stack must rise to clear the thread composer: the distance from the bottom of the
 * visual viewport to the composer's top edge, or 0 when there is no composer (the list, settings).
 */
export function composerClearance(): number {
  if (typeof document === "undefined") return 0;
  const composer = document.querySelector<HTMLElement>('[data-region="composer"]');
  if (!composer) return 0;
  const top = composer.getBoundingClientRect().top;
  const viewportBottom = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight;
  return Math.max(0, Math.round(viewportBottom - top));
}

export function ToastStack() {
  const toasts = useMessageToasts((s) => s.toasts);
  const undo = useThreadUndoNotice((s) => s.notice);
  const visible = toasts.length > 0 || undo !== null;
  const [lift, setLift] = useState(0);
  useLayoutEffect(() => {
    if (!visible) return;
    const measure = () => setLift(composerClearance());
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [visible, toasts.length, undo?.id]);
  return (
    <div
      style={lift > 0 ? { bottom: lift } : undefined}
      className={
        "pointer-events-none fixed inset-x-0 bottom-0 z-[140] flex flex-col items-center gap-2 px-4 " +
        (lift > 0 ? "pb-2" : "pb-[max(env(safe-area-inset-bottom),1rem)]")
      }
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          onClick={() => dismissToast(t.id)}
          className={
            "pointer-events-auto max-w-sm rounded-lg border bg-card px-3 py-2 text-sm shadow-lg " +
            (t.tone === "error" ? "border-warn text-warn" : "text-foreground")
          }
        >
          {t.text}
        </div>
      ))}
      <SidebarThreadUndoNotice />
    </div>
  );
}
