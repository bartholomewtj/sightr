/**
 * The toast stack: the one undo notice (hooks/showThreadUndoNotice.ts) and short plain messages
 * ("Pick a snooze time from the menu", a refused command). Mounted once in the root layout, so a toast
 * outlives the route that raised it (on a phone the sidebar unmounts when a thread opens).
 */
import { create } from "zustand";

import { SidebarThreadUndoNotice } from "@/components/sidebar/SidebarThreadUndoNotice";

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

export function ToastStack() {
  const toasts = useMessageToasts((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[140] flex flex-col items-center gap-2 px-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
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
