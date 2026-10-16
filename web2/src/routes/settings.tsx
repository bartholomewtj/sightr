// Same job and name as T3 Code apps/web/src/routes/settings.tsx @ e3b35d1b (pattern; MIT, see
// THIRD_PARTY.md). T3 splits Settings into child routes under a settings sidebar; Sightr has a handful
// of rows, and the phone reads them as one scroll, so the sections sit on one page in the T18 order,
// built from T3's SettingsSection / SettingsRow (components/settings/settingsLayout.tsx). Each section
// uses the bridge endpoint v1 uses for the same setting (no new bridge route). Read-only devices see
// every section and can change only the per-device ones.
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ExternalLinkIcon, KeyboardIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { KeyboardShortcutsDialog, openShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { BridgeSettings } from "@/components/settings/BridgeSettings";
import { ComposerSettings } from "@/components/settings/ComposerSettings";
import { ConnectionInfo } from "@/components/settings/ConnectionInfo";
import { DisplaySettings } from "@/components/settings/DisplaySettings";
import { GestureWheelSettingsSlot } from "@/components/settings/GestureWheelSettingsSlot";
import { LockSettings } from "@/components/settings/LockSettings";
import { NotificationSettings } from "@/components/settings/NotificationSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "@/components/settings/settingsLayout";
import { ThemeSettings } from "@/components/settings/ThemeSettings";
import { useLayout } from "@/hooks/useLayout";
import { formatShortcutLabel, KEYBINDINGS } from "@/keybindings";
import { SIGHTR_V1_PATH } from "@/lib/v1-path";
import { useBridgeInfo } from "@/stream/stores";

export const Route = createFileRoute("/settings")({
  component: SettingsRouteView,
});

function SettingsRouteView() {
  const desktop = useLayout() === "desktop";
  const readOnly = useBridgeInfo((s) => s.readOnly);
  const device = useBridgeInfo((s) => s.device);
  const shortcutsKey = KEYBINDINGS.find((b) => b.command === "shortcuts.open");

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button size="icon-sm" variant="ghost" aria-label="Back to threads" render={<Link to="/" />}>
          <ArrowLeftIcon />
        </Button>
        <h1 className="text-base font-semibold">Settings</h1>
      </header>
      <SettingsPageContainer>
        <SettingsSection title="Display" id="display">
          <ThemeSettings />
          <DisplaySettings />
        </SettingsSection>

        <SettingsSection title="Composer" id="composer">
          <ComposerSettings />
        </SettingsSection>

        <SettingsSection title="Notifications" id="notifications">
          <NotificationSettings readOnly={readOnly} />
        </SettingsSection>

        <SettingsSection title="Security" id="security">
          <LockSettings readOnly={readOnly} />
        </SettingsSection>

        <SettingsSection title="Bridge" id="bridge">
          <BridgeSettings readOnly={readOnly} device={device} />
        </SettingsSection>

        <SettingsSection title="Connection" id="connection">
          <ConnectionInfo />
        </SettingsSection>

        {desktop ? (
          <SettingsSection title="Shortcuts" id="shortcuts">
            <SettingsRow
              title="Keyboard shortcuts"
              description={`Every desktop shortcut${shortcutsKey ? `. Press ${formatShortcutLabel(shortcutsKey.shortcut)} anywhere` : ""}.`}
              control={
                <Button size="sm" variant="outline" onClick={openShortcutsDialog}>
                  <KeyboardIcon />
                  Show shortcuts
                </Button>
              }
            />
          </SettingsSection>
        ) : null}

        <GestureWheelSettingsSlot />

        <SettingsSection title="Sightr v1" id="sightr-v1">
          <SettingsRow
            title="Open Sightr v1"
            description="The previous app, kept at /v1/ for this release."
            control={
              <Button size="sm" variant="outline" render={<a href={SIGHTR_V1_PATH} />}>
                <ExternalLinkIcon />
                Open Sightr v1
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>
      {/* Settings sits outside the chat shell, which mounts the sheet for the rest of the app. */}
      <KeyboardShortcutsDialog />
    </div>
  );
}
