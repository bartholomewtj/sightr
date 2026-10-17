/**
 * One thread row (T10): harness icon, title, unread mark, status dot, last activity. Focusable; Enter
 * opens (it is a link), Space or right click opens the row menu, a long press does too on touch. On a
 * phone the row swipes: right reveals Pin, left reveals Settle and Archive, a full swipe runs the first.
 * On desktop `SortableThreadRow` makes it draggable (@dnd-kit, as T3's Sidebar.tsx rows).
 */
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "@tanstack/react-router";
import { Archive, Check, Pin, PinOff } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type Ref,
} from "react";

import type { Thread } from "@shared/v2/contracts";
import { timeAgoShort } from "@v1/lib/format";

import { AgentIcon } from "@/components/AgentIcon";
import { effectiveStatus, resolveSidebarRowAccessibility, statusLabel, type ShelfCommand } from "@/components/Sidebar.logic";
import { snoozeWakeLabel } from "@/components/Sidebar.snooze";
import { ThreadStatusDot } from "@/components/ThreadStatusIndicators";
import { useSwipeActions, type SwipeSide } from "@/hooks/useSwipeActions";
import { cn } from "@/lib/utils";
import { useWorkingSince } from "@/state/sidebar";
import { useWoke } from "@/state/woke";

import { LONG_PRESS_MS, useLongPress } from "./useLongPress";

export { LONG_PRESS_MS };

export interface SidebarRowActions {
  activeThreadId: string | undefined;
  /** Phone layout: swipe and long press on, drag off. */
  touch: boolean;
  /** While mod is held (desktop): the key that opens each of the first nine rows, by thread id. */
  jumpLabels?: ReadonlyMap<string, string> | null;
  renamingId: string | null;
  openMenu(threadId: string, anchor: HTMLElement): void;
  startRename(threadId: string): void;
  endRename(): void;
  run(command: ShelfCommand): void;
}

export const SidebarRowContext = createContext<SidebarRowActions | null>(null);

function useRowActions(): SidebarRowActions {
  const ctx = useContext(SidebarRowContext);
  if (!ctx) throw new Error("SidebarThreadRow outside SidebarRowContext");
  return ctx;
}

interface DragBits {
  setNodeRef?: Ref<HTMLLIElement>;
  style?: CSSProperties;
  listeners?: Record<string, (event: never) => void>;
  dragging?: boolean;
}

export function SortableThreadRow(props: { thread: Thread; projectLabel?: string; draggable: boolean }) {
  const { setNodeRef, transform, transition, listeners, isDragging } = useSortable({
    id: props.thread.id,
    disabled: !props.draggable,
  });
  return (
    <SidebarThreadRow
      {...props}
      drag={{
        setNodeRef,
        style: { transform: CSS.Translate.toString(transform), transition },
        listeners: listeners as DragBits["listeners"],
        dragging: isDragging,
      }}
    />
  );
}

export function SidebarThreadRow({
  thread,
  projectLabel,
  drag,
}: {
  thread: Thread;
  /** Shown in flat lists (search, Needs you), where rows from many projects mix. */
  projectLabel?: string;
  drag?: DragBits;
}) {
  const actions = useRowActions();
  const status = effectiveStatus(thread);
  const workingSince = useWorkingSince((s) => s.since[thread.id]);
  const isActive = actions.activeThreadId === thread.id;
  const woke = useWoke((s) => s.woke[thread.id] !== undefined) && thread.shelf === "active";
  const a11y = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: woke ? `${statusLabel(status)}, woke from snooze` : statusLabel(status),
    projectDisplayName: projectLabel ?? null,
    isActive,
  });
  const rowRef = useRef<HTMLAnchorElement>(null);
  const jumpLabel = actions.jumpLabels?.get(thread.id) ?? null;

  const pinned = thread.shelf === "pinned";
  const swipe = useSwipeActions({
    enabled: actions.touch && actions.renamingId !== thread.id,
    sides: { right: 1, left: 2 },
    onFull: (side: SwipeSide) =>
      actions.run(side === "right" ? { type: pinned ? "thread.unpin" : "thread.pin", threadId: thread.id } : { type: "thread.settle", threadId: thread.id }),
  });

  // Long press (any touch, a tablet in the desktop layout too) opens the menu; the click that ends it
  // must not navigate.
  const press = useLongPress((el) => actions.openMenu(thread.id, el));

  const onPointerDown = (e: PointerEvent<HTMLAnchorElement>) => {
    drag?.listeners?.onPointerDown?.(e as never);
    swipe.handlers.onPointerDown(e);
    press.onPointerDown(e);
  };
  const onPointerMove = (e: PointerEvent<HTMLAnchorElement>) => {
    swipe.handlers.onPointerMove(e);
    press.onPointerMove(e);
  };
  const onPointerUp = (e: PointerEvent<HTMLAnchorElement>) => {
    press.cancel();
    swipe.handlers.onPointerUp(e);
  };
  const onPointerCancel = (e: PointerEvent<HTMLAnchorElement>) => {
    press.cancel();
    swipe.handlers.onPointerCancel(e);
  };
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    const longPressed = press.consumeClick();
    if (longPressed || swipe.offset !== 0 || swipe.swiping) {
      e.preventDefault();
      swipe.close();
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      actions.openMenu(thread.id, e.currentTarget);
    }
  };
  const onContextMenu = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    press.cancel();
    actions.openMenu(thread.id, e.currentTarget);
  };

  const run = (command: ShelfCommand) => {
    swipe.close();
    actions.run(command);
  };

  return (
    <li
      ref={drag?.setNodeRef}
      style={drag?.style}
      data-thread-item={thread.id}
      data-dragging={drag?.dragging || undefined}
      className={cn("relative list-none overflow-hidden", drag?.dragging && "z-10 opacity-80")}
    >
      {swipe.offset > 0 || swipe.revealed === "right" ? (
        <div className="absolute inset-y-0 left-0 flex">
          <button
            type="button"
            className="flex w-14 items-center justify-center bg-you text-chip-ink"
            aria-label={pinned ? "Unpin" : "Pin"}
            onClick={() => run({ type: pinned ? "thread.unpin" : "thread.pin", threadId: thread.id })}
          >
            {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          </button>
        </div>
      ) : null}
      {swipe.offset < 0 || swipe.revealed === "left" ? (
        <div className="absolute inset-y-0 right-0 flex">
          <button
            type="button"
            className="flex w-14 items-center justify-center bg-ok text-chip-ink"
            aria-label="Settle"
            onClick={() => run({ type: "thread.settle", threadId: thread.id })}
          >
            <Check className="size-4" />
          </button>
          <button
            type="button"
            className="flex w-14 items-center justify-center bg-warn text-chip-ink"
            aria-label="Archive"
            onClick={() => run({ type: "thread.archive", threadId: thread.id })}
          >
            <Archive className="size-4" />
          </button>
        </div>
      ) : null}
      <div
        className="relative bg-sidebar"
        style={swipe.offset !== 0 ? { transform: `translateX(${swipe.offset}px)` } : undefined}
      >
        {actions.renamingId === thread.id ? (
          <RenameField thread={thread} onDone={actions.endRename} run={actions.run} />
        ) : (
          <Link
            ref={rowRef}
            to="/thread/$threadId"
            params={{ threadId: thread.id }}
            data-sidebar-row=""
            aria-label={a11y.label}
            aria-current={a11y.current}
            data-status={isActive ? "active" : undefined}
            className={cn(
              "flex touch-pan-y items-center gap-2 px-3 py-1.5 text-sm outline-none select-none [-webkit-touch-callout:none] hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11",
              isActive && "bg-sidebar-row-active",
            )}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onClick={onClick}
            onKeyDown={(e: KeyboardEvent<HTMLAnchorElement>) => {
              onKeyDown(e);
              drag?.listeners?.onKeyDown?.(e as never);
            }}
            onContextMenu={onContextMenu}
          >
            <AgentIcon agent={thread.harness} className="size-5" />
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate", thread.unreadDone && "font-semibold")}>{thread.title}</span>
              {projectLabel ? <span className="block truncate text-2xs text-muted-foreground">{projectLabel}</span> : null}
            </span>
            {thread.unreadDone ? <span role="img" aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-you" /> : null}
            <ThreadStatusDot status={status} workingSince={workingSince} />
            {thread.shelf === "snoozed" && thread.snoozedUntil !== undefined ? (
              <span className="shrink-0 font-mono text-2xs text-muted-foreground" title="Wakes in">
                {snoozeWakeLabel(thread.snoozedUntil, Date.now())}
              </span>
            ) : status === "working" ? null : (
              <>
                {woke ? (
                  <span data-woke="" title="Its snooze ended" className="shrink-0 rounded-full border border-you px-1.5 text-3xs font-medium text-foreground">
                    Woke
                  </span>
                ) : null}
                <time
                  dateTime={new Date(thread.lastActivityAt).toISOString()}
                  className="shrink-0 font-mono text-2xs text-muted-foreground"
                >
                  {timeAgoShort(thread.lastActivityAt)}
                </time>
              </>
            )}
          </Link>
        )}
      </div>
      {jumpLabel ? <JumpHintBadge label={jumpLabel} /> : null}
    </li>
  );
}

/** T3's JumpHintBadge: the key that opens this row, over its right edge while mod is held. */
function JumpHintBadge({ label }: { label: string }) {
  return (
    <span
      aria-hidden
      data-jump-hint=""
      className="pointer-events-none absolute top-1/2 right-1.5 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
    >
      {label}
    </span>
  );
}

/** Inline rename: Enter sends `thread.rename`, Escape cancels, an empty title is refused. */
function RenameField({ thread, onDone, run }: { thread: Thread; onDone(): void; run(command: ShelfCommand): void }) {
  const [value, setValue] = useState(thread.title);
  const [invalid, setInvalid] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // After the row menu has closed and handed focus back.
    const id = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => clearTimeout(id);
  }, []);
  return (
    <div className="flex items-center gap-2 px-3 py-1">
      <AgentIcon agent={thread.harness} className="size-5" />
      <input
        ref={ref}
        aria-label="Thread title"
        aria-invalid={invalid || undefined}
        className={cn(
          "h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-base text-foreground outline-none focus-visible:border-ring sm:text-sm pointer-coarse:h-10",
          invalid && "border-warn",
        )}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const title = value.trim();
            if (!title) {
              setInvalid(true);
              return;
            }
            if (title !== thread.title) run({ type: "thread.rename", threadId: thread.id, title });
            onDone();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          }
        }}
        onBlur={onDone}
      />
    </div>
  );
}
