// Same job and name as T3 Code apps/web/src/routes/settings.tsx @ e3b35d1b (pattern; MIT, see
// THIRD_PARTY.md). T3 splits Settings into child routes under a settings sidebar; Sightr has a handful
// of rows, and the phone reads them as one scroll: sections in order (Display, Composer, New threads,
// Notifications, Security, Advanced, About), built from T3's SettingsSection / SettingsRow
// (components/settings/settingsLayout.tsx), with section chips pinned under the header (SettingsNav) and
// the bridge, connection, shortcuts and v1 rows folded into "Advanced" (FoldedSettingsSection) so the
// page stays short at 360 px. Each section uses the bridge endpoint v1 uses for the same setting (no new
// bridge route). Read-only devices see every section and can change only the per-device ones.
import { createFileRoute } from "@tanstack/react-router";
import { ExternalLinkIcon, KeyboardIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { BackToThreads } from "@/components/shell/BackToThreads";
import { KeyboardShortcutsDialog, openShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { AboutSettings } from "@/components/settings/AboutSettings";
import { BridgeSettings } from "@/components/settings/BridgeSettings";
import { ComposerSettings } from "@/components/settings/ComposerSettings";
import { ConnectionInfo } from "@/components/settings/ConnectionInfo";
import { DisplaySettings } from "@/components/settings/DisplaySettings";
import { FoldedSettingsSection } from "@/components/settings/FoldedSettingsSection";
import { GestureWheelSettingsSlot } from "@/components/settings/GestureWheelSettingsSlot";
import { LockSettings } from "@/components/settings/LockSettings";
import { NewThreadSettings } from "@/components/settings/NewThreadSettings";
import { NotificationSettings } from "@/components/settings/NotificationSettings";
import { SettingsNav, type SettingsNavItem } from "@/components/settings/SettingsNav";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "@/components/settings/settingsLayout";
import { ThemeSettings } from "@/components/settings/ThemeSettings";
import { useLayout } from "@/hooks/useLayout";
import { formatShortcutLabel, KEYBINDINGS } from "@/keybindings";
import { SIGHTR_V1_PATH } from "@/lib/v1-path";
import { useBridgeInfo } from "@/stream/stores";

export const Route = createFileRoute("/settings")({
  component: SettingsRouteView,
});

const NAV: readonly SettingsNavItem[] = [
  { id: "display", label: "Display" },
  { id: "composer", label: "Composer" },
  { id: "new-threads", label: "New threads" },
  { id: "notifications", label: "Notifications" },
  { id: "security", label: "Security" },
  { id: "advanced", label: "Advanced" },
  { id: "about", label: "About" },
];

function SettingsRouteView() {
  const desktop = useLayout() === "desktop";
  const readOnly = useBridgeInfo((s) => s.readOnly);
  const device = useBridgeInfo((s) => s.device);
  const shortcutsKey = KEYBINDINGS.find((b) => b.command === "shortcuts.open");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <BackToThreads />
        <h1 className="text-base font-semibold">Settings</h1>
      </header>
      <SettingsNav items={NAV} onJump={(id) => id === "advanced" && setAdvancedOpen(true)} />
      <SettingsPageContainer>
        <SettingsSection title="Display" id="display">
          <ThemeSettings />
          <DisplaySettings />
        </SettingsSection>

        <SettingsSection title="Composer" id="composer">
          <ComposerSettings />
        </SettingsSection>

        <GestureWheelSettingsSlot />

        <SettingsSection title="New threads" id="new-threads">
          <NewThreadSettings />
        </SettingsSection>

        <SettingsSection title="Notifications" id="notifications">
          <NotificationSettings readOnly={readOnly} />
        </SettingsSection>

        <SettingsSection title="Security" id="security">
          <LockSettings readOnly={readOnly} />
        </SettingsSection>

        <FoldedSettingsSection
          id="advanced"
          title="Advanced"
          summary={desktop ? "Bridge, connection, shortcuts, Sightr v1" : "Bridge, connection, Sightr v1"}
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
        >
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
        </FoldedSettingsSection>

        <SettingsSection title="About" id="about">
          <AboutSettings />
        </SettingsSection>
      </SettingsPageContainer>
      {/* Settings sits outside the chat shell, which mounts the sheet for the rest of the app. */}
      <KeyboardShortcutsDialog />
    </div>
  );
}
