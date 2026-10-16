// Copied from web/src/components/push-onboarding.tsx: the one-time card that offers push (or, on an
// iPhone not yet installed, the Home Screen steps). Shown on the home screen above the threads, once
// the shell snapshot says who this device is. Reads read-only from the shell stream (v1 had a device
// store for it).
import { useEffect, useId, useState } from "react";

import { cn } from "~/lib/utils";
import {
  dismissPushOnboarding,
  enablePush,
  getPushState,
  IOS_INSTALL_NOTE,
  IOS_INSTALL_STEPS,
  IOS_INSTALL_TITLE,
  isPushOnboarded,
  markPushOnboarded,
  needsHomeScreenInstall,
  pushFailureText,
  pushOnboardingCard,
  pushOnboardingDismissed,
  pushSupported,
  type PushState,
} from "@/lib/push";
import { useBridgeInfo, useShell } from "@/stream/stores";

export function PushOnboarding({ className }: { className?: string }) {
  const seen = useShell((s) => s.loaded);
  const readOnly = useBridgeInfo((s) => s.readOnly);
  const headingId = useId();
  const stepsId = useId();
  const [state, setState] = useState<PushState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [howOpen, setHowOpen] = useState(false);

  useEffect(() => {
    if (dismissed || !seen || readOnly || isPushOnboarded() || pushOnboardingDismissed()) return;
    let alive = true;
    void getPushState()
      .then((next) => alive && setState(next))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [dismissed, seen, readOnly]);

  const permission = pushSupported() ? Notification.permission : "denied";
  useEffect(() => {
    if (state && permission === "granted" && !isPushOnboarded()) markPushOnboarded();
  }, [state, permission]);

  const mode =
    state && !dismissed
      ? pushOnboardingCard({
          seen,
          readOnly,
          availability: state.availability,
          userDisabled: state.userDisabled,
          permission,
          onboarded: isPushOnboarded(),
          dismissed: pushOnboardingDismissed(),
          iosInstall: needsHomeScreenInstall(),
        })
      : null;

  if (!mode) return null;

  async function turnOn() {
    setBusy(true);
    setError(null);
    try {
      const result = await enablePush();
      if (result.ok) {
        markPushOnboarded();
        setDismissed(true);
      } else setError(pushFailureText(result.reason));
    } catch {
      setError(pushFailureText(undefined));
    } finally {
      setBusy(false);
    }
  }

  function notNow() {
    dismissPushOnboarding();
    setDismissed(true);
  }

  return (
    <section
      data-testid="push-onboarding"
      aria-labelledby={headingId}
      className={cn("flex flex-col gap-2 rounded-xl border border-you bg-you-soft p-3 text-left", className)}
    >
      <h2 id={headingId} className="text-sm font-semibold">
        {mode === "install" ? IOS_INSTALL_TITLE : "Get a notification when an agent needs you."}
      </h2>
      <p className="text-xs text-muted-foreground">
        {mode === "install"
          ? IOS_INSTALL_NOTE
          : "Sightr can buzz this device the moment an agent is waiting on you. You can change this later in Settings."}
      </p>
      <div className="flex flex-wrap gap-2">
        {mode === "install" ? (
          <button
            type="button"
            aria-expanded={howOpen}
            aria-controls={howOpen ? stepsId : undefined}
            onClick={() => setHowOpen((open) => !open)}
            className="min-h-11 rounded-md px-3 text-sm font-medium underline underline-offset-4 sm:min-h-9"
          >
            How
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void turnOn()}
            className="min-h-11 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:min-h-9"
          >
            Turn on notifications
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={notNow}
          className="min-h-11 rounded-md px-3 text-sm underline underline-offset-4 disabled:opacity-50 sm:min-h-9"
        >
          Not now
        </button>
      </div>
      {mode === "install" && howOpen ? (
        <ol id={stepsId} className="list-inside list-decimal space-y-1 text-xs text-muted-foreground">
          {IOS_INSTALL_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
