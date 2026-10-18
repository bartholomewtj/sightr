// Adapted from T3 Code apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx @ db5919d87 (MIT, see THIRD_PARTY.md).
// Changes: fed by the usage_limit `error` item the latest run ended on (`failure.resetAt`, epoch ms).
// Only "Snooze until reset" is offered, as the existing `thread.snooze {until: resetAt}`; there is no
// "Resume at reset" (the bridge has no held-release queue). A Dismiss is added (per device, as
// ThreadErrorBanner). The reset time reads like the snooze menu's ("11:30 AM", "tomorrow 9:00 AM").
import { GaugeIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { snoozeWakeDescription } from "@/components/Sidebar.snooze";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryProps = {
  bannerKey: string;
  resetAt: number | null;
  stoppedAt: number;
  snoozedUntil: number | null;
  disabled?: boolean;
  onSnooze: (until: number) => Promise<boolean>;
  onDismiss: () => void;
};

/** "resets 11:30 AM" in this device's time zone, or null when the agent gave no reset time. */
export function usageLimitResetLabel(resetAt: number | null, now: Date = new Date()): string | null {
  if (resetAt === null || !Number.isFinite(resetAt)) return null;
  const when = snoozeWakeDescription(resetAt, now);
  return when ? `resets ${when}` : null;
}

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { bannerKey, resetAt, stoppedAt } = props;
  const canSchedule = resetAt !== null && resetAt > stoppedAt;
  const reset = usageLimitResetLabel(resetAt);
  return {
    id: `usage-limit-recovery:${bannerKey}`,
    variant: "warning",
    priority: "urgent",
    icon: <GaugeIcon />,
    title: reset ? `Usage limit reached · ${reset}` : "Usage limit reached",
    description: reset ? undefined : "Reset time unavailable; retry manually",
    actions: canSchedule ? <RecoveryActions key={`${bannerKey}:${resetAt}`} {...props} /> : null,
    dismissLabel: "Dismiss",
    onDismiss: props.onDismiss,
  };
}

function RecoveryActions({ resetAt, snoozedUntil, disabled, onSnooze }: RecoveryProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const delay = (resetAt ?? Number.NaN) - Math.max(nowMs, Date.now());
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(delay + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [resetAt, nowMs]);

  const snoozed = resetAt !== null && snoozedUntil !== null && snoozedUntil === resetAt;
  async function snooze() {
    if (resetAt === null) return;
    if (resetAt <= Date.now()) {
      setError("The reset time has passed. Retry the thread manually.");
      setNowMs(Date.now());
      return;
    }
    setPending(true);
    setError(null);
    const ok = await onSnooze(resetAt);
    if (!ok) setError("Could not snooze the thread.");
    setPending(false);
  }
  if (snoozed) return <span className="text-muted-foreground">Snoozed until reset</span>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs" variant="ghost" disabled={disabled || pending || resetAt === null || resetAt <= nowMs} onClick={() => void snooze()}>
        {pending ? "Saving..." : "Snooze until reset"}
      </Button>
      {error ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
