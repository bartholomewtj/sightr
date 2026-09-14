import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { type AgentStatus, STATUS_LABEL } from "@/lib/types";

const DOT: Record<AgentStatus, string> = {
  blocked: "bg-status-blocked",
  working: "bg-status-working",
  done: "bg-status-done",
  idle: "bg-status-idle",
  unknown: "bg-status-unknown",
};

const CHIP: Record<AgentStatus, string> = {
  blocked: "border-status-blocked/30 bg-status-blocked/15 text-status-blocked",
  working: "border-status-working/30 bg-status-working/15 text-status-working",
  done: "border-status-done/30 bg-status-done/15 text-status-done",
  idle: "border-status-idle/30 bg-status-idle/10 text-status-idle",
  unknown: "border-status-unknown/30 bg-status-unknown/10 text-status-unknown",
};

/**
 * As a FILL, the status palette needs a different ramp than it does as text. Every --status-* value
 * is tuned near the same lightness for text contrast, so drawn as solid discs the resting states
 * (idle / unknown) carry exactly as much weight as blocked — eighteen idle dots would out-shout the
 * one thing that needs you. The resting states are therefore hollow rings; the states that mean
 * something is happening stay solid.
 */
const RESTING: ReadonlySet<AgentStatus> = new Set(["idle", "unknown"]);

const RING: Record<AgentStatus, string> = {
  blocked: "border-status-blocked",
  working: "border-status-working",
  done: "border-status-done",
  idle: "border-status-idle/60",
  unknown: "border-status-unknown/60",
};

export function StatusDot({
  status,
  runningCommand,
  surface = "bg-background",
  labelled = false,
  stale = false,
  live = false,
  className,
}: {
  status: AgentStatus;
  /** True when a working agent is mid-command rather than thinking — paints blue instead of amber.
   *  Decorates `working`; non-working statuses ignore the flag. */
  runningCommand?: boolean;
  /**
   * The colour the dot sits ON. A hollow ring must be FILLED with its surface, not left
   * transparent: over the avatar's corner a transparent interior showed orange logo through one
   * half and page grey through the other, reading as a notch cut out of the icon rather than a
   * badge. Pass the card's surface when the dot sits on a card.
   */
  surface?: string;
  /** The dot stands alone (the pane header), so it carries the status text as its accessible name
   *  and tooltip. Off inside a pill or row where the text sits beside it. */
  labelled?: boolean;
  /** Showing the LAST snapshot's status while the connection is not live — dim it so frozen data
   *  doesn't read as current. Same rule the StatusBadge pill uses. */
  stale?: boolean;
  /**
   * Opt in to the working state's breathing animation. One phone screen mounts several StatusDots
   * for the same herd (space chip, tab chip, pane chip, pane header, agent card), and each one
   * animating on its own unsynchronised clock reads as blinking rather than as "alive". Only the
   * dot the operator is actually watching a pane through asks for it: the pane strip's chip and the
   * pane header. Everywhere else the colour carries the state without the motion.
   */
  live?: boolean;
  className?: string;
}) {
  const isRunning = status === "working" && Boolean(runningCommand);
  const hollow = RESTING.has(status);
  const dotColor = isRunning ? "bg-status-running" : DOT[status];
  const label = labelled ? STATUS_LABEL[status] : undefined;
  // Frozen data must not animate as if it were arriving, so `stale` stops the breathe outright.
  const breathing = live && status === "working" && !isRunning && !stale;
  return (
    <span
      role={labelled ? "img" : undefined}
      aria-label={label}
      title={label}
      className={cn("relative flex size-2.5 shrink-0 transition-opacity", stale && "opacity-40", className)}
    >
      {/* size-full, not a second size-2.5: the wrapper owns the size so `className` can change it
          (the chips ask for size-2), and a hard-coded inner would overflow or get squashed by the
          flex parent instead. */}
      <span
        className={cn(
          "relative inline-flex size-full rounded-full",
          breathing && "status-breathe",
          hollow ? cn("border-[1.5px]", surface, RING[status]) : dotColor,
        )}
      />
    </span>
  );
}

export function StatusBadge({
  status,
  runningCommand,
  stale,
  className,
}: {
  status: AgentStatus;
  /** Swaps the inner dot to blue when a working agent is running a command. */
  runningCommand?: boolean;
  /** The badge is showing the LAST snapshot's status while the connection is not live — dim it so
   *  frozen data doesn't read as current. No animation to remove here (the badge dot never pulses),
   *  so opacity alone carries it; the transition restores it instantly on recovery. */
  stale?: boolean;
  className?: string;
}) {
  const isRunning = status === "working" && Boolean(runningCommand);
  const dotColor = isRunning ? "bg-status-running" : DOT[status];
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 transition-opacity", CHIP[status], stale && "opacity-40", className)}
    >
      <span className={cn("size-1.5 rounded-full", dotColor)} />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** Muted "shell" tag shown in place of a StatusBadge for a bare shell pane (no agent). */
export function ShellBadge({ stale, className }: { stale?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-opacity",
        stale && "opacity-40",
        className,
      )}
    >
      shell
    </span>
  );
}
