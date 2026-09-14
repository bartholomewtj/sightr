import { useLocation, useNavigate } from "react-router";

import { cn } from "@/lib/utils";
import { SightrMark, DogGallop } from "@/components/dog-gallop";
import { homePath } from "@/lib/nav";

interface SightrHomeProps {
  /** The connection has been not-live for a sustained beat (useConnectionTrouble, ≥4s) — run the
   *  loader. Below that (healthy, or a single slow poll) the static badge shows: the 4s delay is the
   *  flicker fix, so a normal polling hiccup never kicks the mark into a run. */
  trouble: boolean;
  /** The outage has passed the escalation threshold (useConnectionLost, ≥15s). The mark stops running
   *  and rests on the static badge, muted — a loader that never stops reads as "still trying" when
   *  we've in fact given up; the muted icon says "not connected" at a glance, matching the boot splash. */
  lost?: boolean;
  /** Show the "Sightr" wordmark beside the mark (dashboard header). Omit inside a pane to save space. */
  wordmark?: boolean;
  className?: string;
}

const MARK_SIZE = "3.5rem";

// The single, shared Sightr mark: brand + Spaces button + connection loader in one, so the top-left
// of every screen means the same thing. At rest it's the sightr knockout badge; once the connection
// has been not-live for a sustained beat (`trouble`) it swaps in the running loader — until the outage
// escalates (`lost`), when it drops the loader and rests on the SAME static badge, muted, then
// settles back to full color once live. Tapping it is the Spaces tab: replace-navigate to `/`,
// no-op if you're already there. The dashboard shows the "Sightr" wordmark too; inside a pane
// the mark stands alone (the breadcrumb carries the context).
export function SightrHome({ trouble, lost = false, wordmark = false, className }: SightrHomeProps) {
  const gallop = trouble && !lost;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const onSpaces = pathname === "/" ? undefined : () => navigate(homePath(), { replace: true });
  return (
    <button
      type="button"
      onClick={onSpaces}
      aria-current={pathname === "/" ? "page" : undefined}
      // The loader conveys connection state visually; fold it into the button's accessible name too,
      // so screen-reader and reduced-motion users get it (inside a pane there's no other cue).
      aria-label={!trouble ? "Sightr home" : lost ? "Sightr home — not connected" : "Sightr home — reconnecting"}
      className={cn(
        "-mx-1 flex items-center gap-2 rounded px-1 transition-opacity active:opacity-70",
        className,
      )}
    >
      <span className="grid size-14 shrink-0 place-items-center">
        {gallop ? (
          <DogGallop running size={MARK_SIZE} />
        ) : (
          // Live rest, and the escalated "lost" rest, are the static badge. Muted when lost so it
          // reads asleep — same box as the loader so the mark doesn't resize when it settles.
          <SightrMark className="size-14" muted={lost} />
        )}
      </span>
      {wordmark && <span className="text-lg font-semibold tracking-tight">Sightr</span>}
    </button>
  );
}
