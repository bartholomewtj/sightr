// The composer's two per-device settings (T12 stores them in state/composer.ts; the composer's own
// menu for them moved here): what Enter does, and what a send does while the agent works. T3 keeps
// the same pair in its General settings (`activeTurnDefault`, the send key).
import { resolveEnterMode, setEnterMode, setFollowUp, useComposerSettings, type EnterMode, type FollowUp } from "@/state/composer";
import { useLayout } from "@/hooks/useLayout";
import { SettingsChoice, SettingsRow } from "./settingsLayout";

const ENTER_OPTIONS: ReadonlyArray<{ value: EnterMode; label: string }> = [
  { value: "enter", label: "Enter sends" },
  { value: "mod-enter", label: "Mod+Enter sends" },
];

const FOLLOW_OPTIONS: ReadonlyArray<{ value: FollowUp; label: string }> = [
  { value: "queue", label: "Queue" },
  { value: "steer", label: "Steer" },
];

export function ComposerSettings() {
  const layout = useLayout();
  const stored = useComposerSettings((s) => s.enterMode);
  const followUp = useComposerSettings((s) => s.followUp);
  const enterMode = resolveEnterMode(stored, layout);
  return (
    <>
      <SettingsRow
        title="Enter key"
        description={
          enterMode === "enter"
            ? "Enter sends; Shift+Enter adds a line."
            : "Enter adds a line; Ctrl+Enter (⌘+Enter on a Mac) sends."
        }
        status={stored === null ? `The ${layout === "desktop" ? "desktop" : "phone"} default. This device only.` : "This device only."}
        control={<SettingsChoice label="Enter key" value={enterMode} options={ENTER_OPTIONS} onChange={setEnterMode} />}
      />
      <SettingsRow
        title="While the agent works"
        description={
          followUp === "queue"
            ? "A send waits in the queue and goes when the agent is done."
            : "A send stops the agent, then sends (steer)."
        }
        status="An agent Sightr cannot stop queues instead. This device only."
        control={<SettingsChoice label="While the agent works" value={followUp} options={FOLLOW_OPTIONS} onChange={setFollowUp} />}
      />
    </>
  );
}
