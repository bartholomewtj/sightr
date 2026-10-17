// Same job and name as T3 Code apps/web/src/components/settings/NotificationSettings.tsx @ e3b35d1b
// (pattern; MIT, see THIRD_PARTY.md). T3 asks for browser notifications while the app is open; Sightr
// sends Web Push from the bridge. The rows are v1's (web/src/routes/settings.tsx push card and
// web/src/components/notify-prefs-control.tsx): this device's push switch, then the bridge-wide
// "Notify when" switches, which every device shares.
import { useState } from "react";
import { Loader2 } from "lucide-react";

import type { NotifyPrefs } from "@shared/wire";
import { Switch } from "~/components/ui/switch";
import { setInAppAlerts, useInAppAlerts } from "@/hooks/use-alert-prefs";
import { useNotifyPrefs } from "@/hooks/use-notify-prefs";
import { usePushControl } from "@/hooks/use-push";
import { availabilityNote, pushFailureText } from "@/lib/push";
import { SettingsRow } from "./settingsLayout";

const NOTIFY_ROWS: ReadonlyArray<{ key: keyof NotifyPrefs; label: string; hint: string }> = [
  { key: "blocked", label: "Needs input", hint: "An agent is waiting on you." },
  { key: "done", label: "Finished", hint: "An agent completes its task." },
];

export function NotificationSettings({ readOnly }: { readOnly: boolean }) {
  const { state, busy, setEnabled } = usePushControl();
  const [error, setError] = useState<string | null>(null);

  // On = not turned off here AND a live subscription exists on web2's worker.
  const on = Boolean(state && !state.userDisabled && state.subscribed);
  const blocked = Boolean(state && state.availability !== "ready");
  // Blocked still lets a lingering subscription be turned off, never on.
  const toggleDisabled = busy || !state || (blocked && !on) || readOnly;

  async function toggle(next: boolean) {
    setError(null);
    const res = await setEnabled(next);
    if (next && !res.ok) setError(pushFailureText(res.reason));
  }

  const note = readOnly ? pushFailureText("refused") : state && blocked ? availabilityNote(state.availability) : null;

  return (
    <>
      <SettingsRow
        title="Push notifications"
        description="A notification on this device when an agent needs you. A tap opens the thread."
        status={
          error || note ? (
            <span className={error ? "text-destructive" : undefined} role={error ? "alert" : undefined}>
              {error ?? note}
            </span>
          ) : null
        }
        control={
          // A fixed slot the size of the switch, so the row does not resize when the state lands.
          <div className="flex h-6 w-11 items-center justify-end">
            {state ? (
              <Switch checked={on} disabled={toggleDisabled} onCheckedChange={(next) => void toggle(next)} aria-label="Push notifications" />
            ) : (
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
            )}
          </div>
        }
      />
      <InAppAlertsRow />
      {state?.availability !== "server-off" ? <NotifyWhenRows readOnly={readOnly} /> : null}
    </>
  );
}

function NotifyWhenRows({ readOnly }: { readOnly: boolean }) {
  const { prefs, busy, toggle } = useNotifyPrefs();
  return (
    <>
      {NOTIFY_ROWS.map((row) => (
        <SettingsRow
          key={row.key}
          title={`Notify when: ${row.label}`}
          description={`${row.hint} All devices.`}
          disabled={readOnly}
          control={
            <Switch
              checked={prefs?.[row.key] ?? false}
              disabled={busy || !prefs || readOnly}
              onCheckedChange={(next) => void toggle(row.key, next)}
              aria-label={row.label}
            />
          }
        />
      ))}
    </>
  );
}

/** This device only, and never read-only: it changes nothing on the host. */
function InAppAlertsRow() {
  const on = useInAppAlerts();
  return (
    <SettingsRow
      title="In-app alerts"
      description="While the app is open: a toast when another thread needs you or finishes, and the count on the app icon. This device only."
      control={<Switch checked={on} onCheckedChange={setInAppAlerts} aria-label="In-app alerts" />}
    />
  );
}
