/**
 * Status dots (T10). Same job and name as T3 Code's apps/web/src/components/ThreadStatusIndicators.tsx
 * (`ThreadStatusLabel`'s dot); Sightr's colours and statuses.
 *
 * - approval / input: accent, solid, the "needs you" weight. done: ok, solid, same weight.
 * - failed: warn. working: navy, pulsing (opacity, 1.2 s), with the elapsed time beside it.
 * - idle: a hollow muted ring, quiet. starting: a hollow navy ring with the working pulse.
 * The pulse is the product's one motion; `prefers-reduced-motion` stops it.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import type { ThreadStatus } from "@shared/v2/contracts";
import { elapsed } from "@v1/lib/thinking-pulse";

import { statusLabel } from "@/components/Sidebar.logic";
import { cn } from "@/lib/utils";

/** Token classes per status (a test pins them). */
export const STATUS_DOT_CLASS: Record<ThreadStatus, string> = {
  approval: "size-2.5 bg-you",
  input: "size-2.5 bg-you",
  done: "size-2.5 bg-ok",
  failed: "size-2 bg-warn",
  working: "size-2 bg-navy",
  idle: "size-2 border border-house-muted bg-transparent",
  starting: "size-2 border-[1.5px] border-navy bg-transparent",
};

const PULSING = new Set<ThreadStatus>(["working", "starting"]);

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function motionQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION) : null;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = motionQuery();
      mql?.addEventListener("change", onChange);
      return () => mql?.removeEventListener("change", onChange);
    },
    () => motionQuery()?.matches ?? false,
    () => false,
  );
}

/** The current time, re-read every `ms` while `active`. */
export function useNow(active: boolean, ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

export function ThreadStatusDot({
  status,
  workingSince,
  showElapsed = true,
  className,
}: {
  status: ThreadStatus;
  /** When the current run started (epoch ms); the working dot shows the time since. */
  workingSince?: number | undefined;
  showElapsed?: boolean;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const ticking = status === "working" && workingSince !== undefined;
  const now = useNow(ticking);
  const elapsedText = ticking ? elapsed(now - workingSince) : null;
  const pulse = PULSING.has(status) && !reduced;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5", className)}>
      <span
        role="img"
        aria-label={statusLabel(status, elapsedText)}
        data-status={status}
        className="inline-flex size-3.5 items-center justify-center"
      >
        <span
          data-slot="status-dot"
          className={cn("rounded-full", STATUS_DOT_CLASS[status], pulse && "animate-status-pulse")}
        />
      </span>
      {elapsedText !== null && showElapsed ? (
        <span aria-hidden className="font-mono text-2xs tabular-nums text-navy">
          {elapsedText}
        </span>
      ) : null}
    </span>
  );
}
