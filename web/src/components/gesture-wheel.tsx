import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleDot } from "lucide-react";

import { cn } from "@/lib/utils";
import { useActionEcho } from "@/hooks/use-action-echo";
import { layoutSlices, pickSlice, HOLD_MS, type WheelSlice } from "@/lib/wheel";

export const WHEEL_ECHO_MS = 250;
const DEAD_MAN_MS = 6000;

export interface GestureWheelProps {
  slices: readonly WheelSlice[];
  /** Send one batch. Resolves the bridge's verdict, like every other pressKeys caller. */
  onKeys: (keys: string[]) => Promise<boolean>;
  /** The Type slice: arm direct typing, or stop it when `typeActive`. */
  onType: () => void;
  typeActive: boolean;
  /** A plain tap (released before HOLD_MS): toggle the Keys dock. */
  onTap: () => void;
  /** Pane gone / read-only / a send in flight — dimmed and inert. */
  disabled: boolean;
}

export function GestureWheel({
  slices,
  onKeys,
  onType,
  typeActive,
  onTap,
  disabled,
}: GestureWheelProps) {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [failedId, setFailedId] = useState<string | null>(null);

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadManTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const activePointer = useRef(false);
  const handleRef = useRef<HTMLButtonElement | null>(null);

  const echo = useActionEcho(WHEEL_ECHO_MS);

  const closeWheel = useCallback(() => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (deadManTimer.current) {
      clearTimeout(deadManTimer.current);
      deadManTimer.current = null;
    }
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(false);
    setDragging(false);
    setHoverIndex(null);
    setFailedId(null);
    fired.current = false;
    activePointer.current = false;
    pointerIdRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      if (deadManTimer.current) clearTimeout(deadManTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const fireSlice = useCallback(
    (slice: WheelSlice, index: number) => {
      if (fired.current) return;
      fired.current = true;
      setDragging(false);

      if (slice.kind === "type") {
        onType();
        closeWheel();
        return;
      }

      const sliceId = `slice-${index}`;
      void echo.run(sliceId, async () => {
        const ok = await onKeys(slice.keys);
        if (!ok) {
          setFailedId(sliceId);
        }
        return ok;
      });

      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => {
        closeWheel();
      }, WHEEL_ECHO_MS);
    },
    [closeWheel, echo, onKeys, onType],
  );

  const onHandlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.button !== 0) return;
    e.preventDefault();

    if (open) {
      closeWheel();
      return;
    }

    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);

    const { clientX, clientY, pointerId } = e;
    pointerIdRef.current = pointerId;
    activePointer.current = true;

    try {
      e.currentTarget.setPointerCapture?.(pointerId);
    } catch {}

    const rect = e.currentTarget.getBoundingClientRect();
    const originX = rect.width > 0 ? rect.left + rect.width / 2 : clientX;
    const originY = rect.height > 0 ? rect.top + rect.height / 2 : clientY;
    setOrigin({ x: originX, y: originY });

    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      fired.current = false;
      setOpen(true);
      setDragging(true);

      if (deadManTimer.current) clearTimeout(deadManTimer.current);
      deadManTimer.current = setTimeout(() => {
        closeWheel();
      }, DEAD_MAN_MS);
    }, HOLD_MS);
  };

  const onHandlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!activePointer.current) return;
    if (!open || !dragging) return;
    const dx = e.clientX - origin.x;
    const dy = e.clientY - origin.y;
    const pick = pickSlice(dx, dy, slices.length);
    if (pick.kind === "slice") {
      setHoverIndex(pick.index);
    } else {
      setHoverIndex(null);
    }
  };

  const onHandlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!activePointer.current) return;
    activePointer.current = false;
    try {
      if (pointerIdRef.current !== null) {
        e.currentTarget.releasePointerCapture?.(pointerIdRef.current);
      }
    } catch {}
    pointerIdRef.current = null;

    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
      onTap();
      return;
    }

    if (open) {
      if (fired.current) return;
      const dx = e.clientX - origin.x;
      const dy = e.clientY - origin.y;
      const pick = pickSlice(dx, dy, slices.length);
      if (pick.kind === "slice") {
        const slice = slices[pick.index];
        if (slice) {
          fireSlice(slice, pick.index);
        }
      } else if (pick.kind === "dead") {
        setDragging(false);
        setHoverIndex(null);
      } else {
        closeWheel();
      }
    }
  };

  const onHandlePointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    try {
      if (pointerIdRef.current !== null) {
        e.currentTarget.releasePointerCapture?.(pointerIdRef.current);
      }
    } catch {}
    closeWheel();
  };

  const points = layoutSlices(slices.length);

  return (
    <>
      <button
        ref={handleRef}
        type="button"
        aria-label="Shortcut wheel"
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerCancel}
        className={cn(
          "absolute right-0 -top-10 size-10 rounded-full flex items-center justify-center",
          "bg-muted/80 border border-border/70 backdrop-blur-sm text-muted-foreground select-none",
          open ? "z-50" : "z-30",
          disabled && "opacity-50 cursor-not-allowed",
        )}
        style={{
          touchAction: "none",
          userSelect: "none",
          WebkitTouchCallout: "none",
        }}
      >
        <CircleDot className="size-4" />
      </button>

      {open && (
        <>
          {!dragging && (
            <div
              className="fixed inset-0 z-40 bg-transparent"
              onClick={closeWheel}
              aria-hidden="true"
            />
          )}
          <div
            role="menu"
            aria-label="Shortcut wheel"
            onContextMenu={(e) => e.preventDefault()}
            className="fixed z-50 pointer-events-none"
            style={{
              left: origin.x,
              top: origin.y,
            }}
          >
            {slices.map((slice, i) => {
              const pt = points[i];
              if (!pt) return null;
              const isHovered = dragging && hoverIndex === i;
              const sliceId = `slice-${i}`;
              const isDone = echo.phaseOf(sliceId) === "done";
              const isFailed = failedId === sliceId;

              const isType = slice.kind === "type";
              const label = isType
                ? (typeActive ? "Stop" : slice.label)
                : slice.label;

              return (
                <button
                  key={i}
                  role="menuitem"
                  type="button"
                  aria-label={label}
                  aria-pressed={isType ? typeActive : undefined}
                  disabled={disabled || fired.current}
                  onClick={(e) => {
                    e.stopPropagation();
                    fireSlice(slice, i);
                  }}
                  className={cn(
                    "absolute size-11 rounded-full border border-border/70 font-medium shadow-md backdrop-blur-sm",
                    "flex items-center justify-center text-xs select-none transition-all pointer-events-auto",
                    isFailed
                      ? "bg-destructive text-destructive-foreground border-destructive"
                      : isDone || isHovered
                        ? "bg-primary text-primary-foreground border-primary scale-110"
                        : "bg-muted/90 text-foreground hover:bg-muted",
                  )}
                  style={{
                    left: pt.dx,
                    top: pt.dy,
                    transform: "translate(-50%, -50%)",
                  }}
                >
                  {isDone ? <Check className="size-4" /> : label}
                </button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
