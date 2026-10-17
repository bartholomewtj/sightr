// Text: the app's text size and how code blocks wrap (state/text-prefs.ts), next to the Terminal tab's own size.
// From web/src/components/display-prefs.tsx (`DisplayPrefsContent`), the rows that mean something in
// web2: Show thinking (the timeline's thought rows) and the Terminal tab's text size. v1's Tap to type,
// Show terminal and Raw terminal are v1 pane-screen prefs (web2's Terminal tab is always raw), and its
// desktop-mode control is gone: web2's layout is width-based (T09).
import { AArrowDown, AArrowUp } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { setDisplayPref, useDisplayPrefs } from "@/hooks/use-display-prefs";
import { TERMINAL_FONT_MAX, TERMINAL_FONT_MIN, useRightPanelStore } from "@/rightPanelStore";
import { setTextPref, useTextPrefs, type CodeWrap, type TextScale } from "@/state/text-prefs";
import { SettingsChoice, SettingsRow } from "./settingsLayout";

const SCALE_OPTIONS: ReadonlyArray<{ value: `${TextScale}`; label: string }> = [
  { value: "90", label: "Small" },
  { value: "100", label: "Default" },
  { value: "115", label: "Large" },
  { value: "130", label: "Larger" },
];

const WRAP_OPTIONS: ReadonlyArray<{ value: CodeWrap; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "wrap", label: "Wrap" },
  { value: "scroll", label: "Scroll" },
];

export function DisplaySettings() {
  const { showThinking } = useDisplayPrefs();
  const fontSize = useRightPanelStore((s) => s.terminalFontSize);
  const setFontSize = useRightPanelStore((s) => s.setTerminalFontSize);
  const { textScale, codeWrap } = useTextPrefs();
  return (
    <>
      <SettingsRow
        title="Text size"
        description="Scales the whole app: chat, composer, lists and menus. The Terminal tab keeps its own size, below. This device only."
        control={
          <SettingsChoice
            label="Text size"
            value={`${textScale}` as `${TextScale}`}
            options={SCALE_OPTIONS}
            onChange={(v) => setTextPref("textScale", Number(v) as TextScale)}
          />
        }
      />
      <SettingsRow
        title="Code wrapping"
        description={
          codeWrap === "auto"
            ? "Code blocks in the chat start wrapped on a phone and scroll sideways on a wide screen. Each block has its own Wrap lines button."
            : codeWrap === "wrap"
              ? "Every code block starts wrapped. Each block has its own Wrap lines button."
              : "Every code block starts as one line per line of code, scrolling sideways. Each block has its own Wrap lines button."
        }
        status="Applies to blocks that appear after the change. This device only."
        control={<SettingsChoice label="Code wrapping" value={codeWrap} options={WRAP_OPTIONS} onChange={(v) => setTextPref("codeWrap", v)} />}
      />
      <SettingsRow
        title="Show thinking"
        description="On, the agent's thought traces sit in the timeline as rows you can expand. Off hides them; the run banner still times the work. This device only."
        control={<Switch checked={showThinking} onCheckedChange={(on) => setDisplayPref("showThinking", on)} aria-label="Show thinking" />}
      />
      <SettingsRow
        title="Terminal text size"
        description="The Terminal tab's own font size; pinch to zoom there changes it too. Not affected by Text size. This device only."
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
