import { useEffect, useId, useState } from "react";

import { cn } from "@/lib/utils";
import { SightrMark } from "@/components/sightr-mark";
import { usePushDevice } from "@/hooks/use-push";
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

export function PushOnboarding({ className }: { className?: string }) {
  const { seen, readOnly } = usePushDevice();
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
    void getPushState().then((next) => alive && setState(next)).catch(() => {});
    return () => { alive = false; };
  }, [dismissed, seen, readOnly]);

  const permission = pushSupported() ? Notification.permission : "denied";
  useEffect(() => {
    if (state && permission === "granted" && !isPushOnboarded()) markPushOnboarded();
  }, [state, permission]);

  const mode = state && !dismissed ? pushOnboardingCard({
    seen,
    readOnly,
    availability: state.availability,
    userDisabled: state.userDisabled,
    permission,
    onboarded: isPushOnboarded(),
    dismissed: pushOnboardingDismissed(),
    iosInstall: needsHomeScreenInstall(),
  }) : null;

  useEffect(() => {
    if (!mode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismissPushOnboarding();
      setDismissed(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode]);

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
    <section data-testid="push-onboarding" aria-labelledby={headingId} className={cn("flex flex-col gap-3 rounded-xl border-2 border-foreground bg-card p-4 text-left", className)}>
      <div className="flex items-center gap-2">
        <SightrMark className="size-8 shrink-0" />
        <h2 id={headingId} className="text-base font-semibold tracking-tight">
          {mode === "install" ? IOS_INSTALL_TITLE : "Get a notification when an agent needs you."}
        </h2>
      </div>
      <p className="text-sm text-muted-foreground">
        {mode === "install" ? IOS_INSTALL_NOTE : "Sightr can buzz your phone the moment an agent is blocked and waiting on you. You can change this later in Settings."}
      </p>
      <div className="flex flex-wrap gap-3">
        {mode === "install" ? (
          <>
            <button type="button" aria-expanded={howOpen} aria-controls={howOpen ? stepsId : undefined} onClick={() => setHowOpen((open) => !open)} className="rounded-md px-3 py-3 text-sm font-medium underline underline-offset-4">
              How
            </button>
            <button type="button" disabled={busy} onClick={notNow} className="rounded-md px-3 py-3 text-sm underline underline-offset-4 disabled:opacity-50">Not now</button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={turnOn} className="rounded-md border-2 border-you bg-you px-3 py-3 text-sm font-medium text-you-foreground hover:bg-you/90 disabled:opacity-50">Turn on notifications</button>
            <button type="button" disabled={busy} onClick={notNow} className="rounded-md px-3 py-3 text-sm underline underline-offset-4 disabled:opacity-50">Not now</button>
          </>
        )}
      </div>
      {mode === "install" && howOpen && <ol id={stepsId} className="list-inside list-decimal space-y-1 text-sm text-muted-foreground">{IOS_INSTALL_STEPS.map((step) => <li key={step}>{step}</li>)}</ol>}
      {error && <p className="text-sm text-status-blocked">{error}</p>}
    </section>
  );
}
