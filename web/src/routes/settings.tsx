import { useState, type ReactNode } from "react";
import { Bell, Keyboard, Loader2, Terminal } from "lucide-react";
import { useRouteLoaderData } from "react-router";

import { AppHeader } from "@/components/app-header";
import { ConnectionInfo } from "@/components/connection-info";
import { Card } from "@/components/ui/card";
import { NotifyPrefsControl } from "@/components/notify-prefs-control";
import { ThemeControl } from "@/components/theme-control";
import { DesktopControl } from "@/components/desktop-control";
import { Switch } from "@/components/ui/switch";
import { useDesktop } from "@/lib/desktop";
import { usePushControl } from "@/hooks/use-push";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { IOS_INSTALL_NOTE, needsHomeScreenInstall, pushFailureText } from "@/lib/push";
import type { PushAvailability } from "@/lib/push";
import { isReadOnly } from "@/lib/types";
import { cn } from "@/lib/utils";
import { LockSettings } from "@/components/lock-settings";
import { openShortcuts } from "@/hooks/use-desktop-hotkeys";
import { BridgeSettings } from "@/components/bridge-settings";
import { DisplayPrefsContent } from "@/components/display-prefs";
import { WheelPrefsControl } from "@/components/wheel-prefs-control";
import { useDisplayPrefs } from "@/hooks/use-display-prefs";
import { useServerBuild } from "@/lib/server-build";

// Settings page — a bottom-bar destination on the phone, sidebar destination on desktop
// (theme, push, updates…). Lives under the root route, so the snapshot polling/push-setup
// in RootLayout keeps running behind it.
export function SettingsRoute() {
  const { state, busy, setEnabled } = usePushControl();
  const [error, setError] = useState<string | null>(null);

  // Settings lives under the root route, so the live snapshot (bridge + device auth) is right here.
  const root = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  const readOnly = isReadOnly(root?.device);
  const desktop = useDesktop().on;
  const serverBuild = useServerBuild();

  // "On" = the user hasn't disabled it AND a live subscription exists on this device.
  const on = Boolean(state && !state.userDisabled && state.subscribed);
  const blocked = Boolean(state && state.availability !== "ready");
  // When blocked we can still allow turning OFF a lingering subscription, but never turning ON.
  const toggleDisabled = busy || !state || (blocked && !on) || readOnly;

  async function toggle(next: boolean) {
    setError(null);
    const res = await setEnabled(next);
    if (next && !res.ok) setError(pushFailureText(res.reason));
  }

  const pushCard = (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Bell className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">Push notifications</div>
            <p className="text-sm text-muted-foreground">
              Get a notification when an agent needs you.
            </p>
          </div>
        </div>
        {/* Fixed slot the size of the Switch (h-6 w-11): the spinner is smaller, so without it
            the row — and the whole page under it — resized when state landed. */}
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          {state ? (
            <Switch
              checked={on}
              disabled={toggleDisabled}
              onCheckedChange={toggle}
              aria-label="Push notifications"
            />
          ) : (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>

      {((state && blocked) || readOnly) && (
        <p className="border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
          {readOnly ? pushFailureText("refused") : availabilityNote(state!.availability)}
        </p>
      )}
      {error && (
        <p className="border-t border-border/60 px-4 py-2.5 text-xs text-status-blocked">
          {error}
        </p>
      )}
    </Card>
  );

  // Mounted while push state is still UNKNOWN, and only removed once we positively learn the
  // bridge has no VAPID keys. Gating on `state` truthiness instead inserted ~400px into the
  // middle of the page one frame late, shoving everything below it down. This is a bridge-wide
  // setting — which transitions notify — so it is meaningful whatever this particular device's
  // push status turns out to be.
  const notifyCards =
    state?.availability !== "server-off" ? <NotifyPrefsControl readOnly={readOnly} /> : null;

  const deviceCards = (
    <>
      {/* First: it's the setting people come here to change, and below the notification stack it
          sat off-screen on a phone, a scroll into a 1240px page. */}
      <ThemeControl />
      <DisplaySettings />
      <WheelPrefsControl />
      {/* Device behaviour sits with appearance — both are "how this device treats you", as opposed
          to the herd/notification settings below. */}
      <DesktopControl />
      <LockSettings readOnly={readOnly} />
      {desktop && <Card className="p-0"><button type="button" className="flex w-full items-start gap-3 p-4 text-left" onClick={openShortcuts}><Keyboard className="mt-0.5 size-5 shrink-0 text-muted-foreground" /><span><span className="block text-sm font-medium">Keyboard shortcuts</span><span className="mt-1 block text-xs text-muted-foreground">See every desktop shortcut. Press ? anywhere.</span></span></button></Card>}
    </>
  );

  const herdCards = (
    <>
      {pushCard}
      {notifyCards}
      <BridgeSettings readOnly={readOnly} device={root?.device} />
    </>
  );

  return (
    <div className={cn("mx-auto flex min-h-0 w-full flex-1 flex-col", !desktop && "max-w-screen-sm")}>
      {desktop ? (
        <AppHeader bridge={root?.bridge} error={root?.error ?? false} wordmark={false}>
          <span className="truncate font-semibold">Settings</span>
        </AppHeader>
      ) : (
        <header className="sticky top-0 z-20 flex items-center gap-2 border-b-2 border-border bg-muted px-4 py-2 [padding-top:calc(env(safe-area-inset-top)_+_0.5rem)]">
          <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        </header>
      )}

      <main
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto",
          desktop ? "gap-4 p-6" : "space-y-4 p-4",
        )}
      >
        {desktop ? (
          <div className="mx-auto grid w-full max-w-5xl grid-cols-2 items-start gap-6">
            <div className="flex flex-col gap-4">{deviceCards}</div>
            <div className="flex flex-col gap-4">{herdCards}</div>
          </div>
        ) : (
          <>
            {deviceCards}
            {herdCards}
          </>
        )}

        <SettingsWidth desktop={desktop}>
          <ConnectionInfo bridge={root?.bridge} device={root?.device} build={serverBuild} />
        </SettingsWidth>

      </main>
    </div>
  );
}

function DisplaySettings() {
  const { prefs, stepFontSize, setRawTerminal, setTapToFocus, setShowTerminal, setShowThinking } =
    useDisplayPrefs();
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-3 p-4">
        <Terminal className="size-5 shrink-0 text-muted-foreground" />
        <div>
          <div className="font-medium">Display</div>
          <p className="text-sm text-muted-foreground">How the pane looks on this device.</p>
        </div>
      </div>
      <DisplayPrefsContent
        prefs={prefs}
        stepFontSize={stepFontSize}
        setRawTerminal={setRawTerminal}
        setTapToFocus={setTapToFocus}
        setShowTerminal={setShowTerminal}
        setShowThinking={setShowThinking}
      />
    </Card>
  );
}

function SettingsWidth({
  desktop,
  className,
  children,
}: {
  desktop: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(desktop && "mx-auto w-full max-w-5xl", className)}>{children}</div>
  );
}

function availabilityNote(a: PushAvailability): string {
  switch (a) {
    case "insecure":
      return "Unavailable over plain HTTP — serve Sightr over HTTPS to enable push.";
    case "server-off":
      return "The bridge has no VAPID keys configured, so push is disabled server-side.";
    case "denied":
      return "Notifications are blocked for this site. Re-enable them in your browser settings.";
    case "unsupported":
      return needsHomeScreenInstall() ? IOS_INSTALL_NOTE : "This browser doesn't support push notifications.";
    case "ready":
      return "";
  }
}
