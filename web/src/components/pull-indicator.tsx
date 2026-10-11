import { SightrLoader } from "@/components/sightr-mark";
import { cn } from "@/lib/utils";
import type { PullState } from "@/hooks/use-pull-to-refresh";

/** Small mark that tracks a pull and spins once the refresh is in flight. Decorative: the
 *  scroller's aria-busy carries the state for assistive tech. */
export function PullIndicator({ pull, className }: { pull: PullState; className?: string }) {
  const shown = pull.distance > 0 || pull.refreshing;
  if (!shown) return null;
  return (
    <div
      className={cn("pointer-events-none absolute inset-x-0 top-1 z-10 flex justify-center", className)}
      style={{ transform: pull.refreshing ? undefined : `translateY(${Math.min(pull.distance, 72)}px)` }}
    >
      <SightrLoader running={pull.refreshing || pull.ready} size="1.25rem" />
    </div>
  );
}
