/**
 * The toast stack: the one undo notice (hooks/showThreadUndoNotice.ts) and short plain messages
 * ("Pick a snooze time from the menu", a refused command). Mounted once in the root layout, so a toast
 * outlives the route that raised it (on a phone the sidebar unmounts when a thread opens).
 *
 * The stack sits above the bottom safe area and, when a thread's composer is on screen, above the
 * composer, so a toast never covers Send. A tap dismisses a message toast, and on a touch screen so does
 * a horizontal swipe. A toast may carry one action button (a 44 px target on touch): "Open" on a thread
 * alert. A toast raised with a `key` replaces the live toast of that key instead of stacking.
 */
import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { create } from "zustand";

import { SidebarThreadUndoNotice } from "@/components/sidebar/SidebarThreadUndoNotice";
import { useThreadUndoNotice } from "@/hooks/showThreadUndoNotice";
import { swipeAxis } from "@/hooks/useSwipeActions";

export const MESSAGE_TOAST_MS = 4_000;
/** A toast with an action stays long enough to read and reach for. */
export const ACTION_TOAST_MS = 8_000;
/** A horizontal drag of this many px (either way) dismisses a toast. */
export const SWIPE_DISMISS_PX = 72;

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface MessageToast {
  id: number;
  text: string;
  tone: "info" | "error";
  action?: ToastAction;
  key?: string;
}

export interface ToastOptions {
  action?: ToastAction;
  /** A new toast with the same key replaces the live one (one toast per thread). */
  key?: string;
}

export const useMessageToasts = create<{ toasts: MessageToast[] }>(() => ({ toasts: [] }));

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function showToast(text: string, tone: MessageToast["tone"] = "info", options: ToastOptions = {}): number {
  const toast: MessageToast = { id: nextId++, text, tone, ...(options.action ? { action: options.action } : {}), ...(options.key ? { key: options.key } : {}) };
  // Three at most; the oldest goes first. Same key: the older one goes now.
  for (const old of useMessageToasts.getState().toasts) if (toast.key !== undefined && old.key === toast.key) dismissToast(old.id);
  useMessageToasts.setState((s) => ({ toasts: [...s.toasts.slice(-2), toast] }));
  timers.set(
    toast.id,
    setTimeout(() => dismissToast(toast.id), toast.action ? ACTION_TOAST_MS : MESSAGE_TOAST_MS),
  );
  return toast.id;
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  useMessageToasts.setState((s) => (s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : s));
}

export function __resetToasts(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
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
        <ToastItem key={t.id} toast={t} />
      ))}
      <SidebarThreadUndoNotice />
    </div>
  );
}

/** The pure swipe decision: dismiss once the drag is far enough, either way. */
export function swipeDismisses(dx: number): boolean {
  return Math.abs(dx) >= SWIPE_DISMISS_PX;
}

function ToastItem({ toast: t }: { toast: MessageToast }) {
  const start = useRef<{ x: number; y: number; id: number; axis: "x" | "y" | null } | null>(null);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const moved = useRef(false);

  const finish = (e: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const s = start.current;
    start.current = null;
    setDragging(false);
    if (!s || s.id !== e.pointerId || s.axis !== "x") return;
    const dist = e.clientX - s.x;
    if (!cancelled && swipeDismisses(dist)) dismissToast(t.id);
    else setDx(0);
  };

  return (
    <div
      role={t.tone === "error" ? "alert" : "status"}
      onClick={() => {
        // The click that ends a drag is not a tap.
        if (moved.current) {
          moved.current = false;
          return;
        }
        dismissToast(t.id);
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        moved.current = false;
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, axis: null };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        const x = e.clientX - s.x;
        if (s.axis === null) {
          s.axis = swipeAxis(x, e.clientY - s.y);
          if (s.axis === "y") {
            start.current = null; // a scroll: hand it back
            return;
          }
          if (s.axis === "x") {
            setDragging(true);
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }
        }
        if (s.axis === "x") {
          moved.current = true;
          setDx(x);
        }
      }}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      style={{
        touchAction: "pan-y",
        ...(dx !== 0 ? { transform: `translateX(${dx}px)`, opacity: Math.max(0.3, 1 - Math.abs(dx) / 240) } : {}),
        ...(dragging ? {} : { transition: "transform 150ms, opacity 150ms" }),
      }}
      className={
        "pointer-events-auto flex max-w-sm items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-lg " +
        (t.tone === "error" ? "border-warn text-warn" : "text-foreground")
      }
    >
      <span className="min-w-0 flex-1">{t.text}</span>
      {t.action ? (
        <button
          type="button"
          className="-my-2 -mr-1 shrink-0 rounded-md px-2 font-medium text-house-accent underline-offset-4 hover:underline pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-3"
          onClick={(e) => {
            // The action runs; the toast's own tap-to-dismiss does not also fire.
            e.stopPropagation();
            dismissToast(t.id);
            t.action?.onClick();
          }}
        >
          {t.action.label}
        </button>
      ) : null}
    </div>
  );
}
