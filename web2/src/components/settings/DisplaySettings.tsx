// From web/src/components/display-prefs.tsx (`DisplayPrefsContent`), the rows that mean something in
// web2: Show thinking (the timeline's thought rows) and the Terminal tab's text size. v1's Tap to type,
// Show terminal and Raw terminal are v1 pane-screen prefs (web2's Terminal tab is always raw), and its
// desktop-mode control is gone: web2's layout is width-based (T09).
import { AArrowDown, AArrowUp } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { setDisplayPref, useDisplayPrefs } from "@/hooks/use-display-prefs";
import { TERMINAL_FONT_MAX, TERMINAL_FONT_MIN, useRightPanelStore } from "@/rightPanelStore";
import { SettingsRow } from "./settingsLayout";

export function DisplaySettings() {
  const { showThinking } = useDisplayPrefs();
  const fontSize = useRightPanelStore((s) => s.terminalFontSize);
  const setFontSize = useRightPanelStore((s) => s.setTerminalFontSize);
  return (
    <>
      <SettingsRow
        title="Show thinking"
        description="On, the agent's thought traces sit in the timeline as rows you can expand. Off hides them; the run banner still times the work. This device only."
        control={<Switch checked={showThinking} onCheckedChange={(on) => setDisplayPref("showThinking", on)} aria-label="Show thinking" />}
      />
      <SettingsRow
        title="Terminal text size"
        description="The Terminal tab's font size. This device only."
        control={
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={fontSize <= TERMINAL_FONT_MIN}
              onClick={() => setFontSize(fontSize - 1)}
              aria-label="Decrease terminal text size"
            >
              <AArrowDown />
            </Button>
            <span className="w-10 text-center font-mono text-xs tabular-nums text-muted-foreground" data-testid="terminal-font-size">
              {fontSize}px
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={fontSize >= TERMINAL_FONT_MAX}
              onClick={() => setFontSize(fontSize + 1)}
              aria-label="Increase terminal text size"
            >
              <AArrowUp />
            </Button>
          </div>
        }
      />
    </>
  );
}
