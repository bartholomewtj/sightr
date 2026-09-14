import type { ReactNode } from "react";
import { AArrowDown, AArrowUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import { FONT_MAX, FONT_MIN } from "@/hooks/use-display-prefs";
import { useDesktop } from "@/lib/desktop";

// The mirror's display prefs, as LABELLED rows behind the composer's ⚙ toggle.
//
// These used to be a permanent icon-only "View" row above the Controls row — five 28px glyphs that
// cost a whole row of a phone viewport for settings you touch once and then never again. Worse, the
// raw-terminal toggle was a bare `>_` icon whose only explanation was a `title` attribute no phone
// ever shows; nobody could tell what it did. Behind the ⚙ each pref gets a real name and, where it
// isn't self-evident, a sentence.
//
// It rides the same in-flow ComposerDock as Keys/Quick rather than a covering sheet, deliberately:
// every control here changes how the mirror LOOKS, so you have to be able to see the mirror while
// you flip it.

interface DisplayPrefsContentProps {
  prefs: DisplayPrefs;
  stepFontSize: (delta: number) => void;
  setRawTerminal: (raw: boolean) => void;
  setTapToFocus: (tapToFocus: boolean) => void;
  // Kept on the interface: ComposerDrawers types its `display` prop as Parameters<typeof DisplayPrefsContent>[0],
  // and the composer passes the whole prefs bundle through. The Terminal toggle itself is a row in
  // the + menu (composer-menu.tsx), not a switch here.
  setShowTerminal: (showTerminal: boolean) => void;
  setShowThinking: (showThinking: boolean) => void;
}

// One settings row: name (+ optional explanation) on the left, control on the right. Module-level so
// it isn't a fresh component type each render.
function Row({
  label,
  hint,
  htmlFor,
  control,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm font-medium">
          {label}
        </label>
        {hint && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function DisplayPrefsContent({
  prefs,
  stepFontSize,
  setRawTerminal,
  setTapToFocus,
  setShowThinking,
}: DisplayPrefsContentProps) {
  const desktop = useDesktop().on;
  return (
    <div className="divide-y divide-border/60 border-t border-border/60 bg-muted/30 px-3 py-1">
      {!desktop && <Row
        label="Tap to type"
        hint="On, tapping the mirror anywhere opens the keyboard. Off, the mirror behaves like a document — taps land on the text and only the composer opens the keyboard."
        htmlFor="pref-tap-to-focus"
        control={
          <Switch
            id="pref-tap-to-focus"
            checked={prefs.tapToFocus}
            onCheckedChange={setTapToFocus}
            aria-label="Tap to type"
          />
        }
      />}
      <Row
        label="Raw terminal"
        hint="On by default. Keeps the verbatim terminal dump; detected prompt buttons still appear below it. Off strips terminal chrome and status strips."
        htmlFor="pref-raw"
        control={
          <Switch
            id="pref-raw"
            checked={prefs.rawTerminal}
            onCheckedChange={setRawTerminal}
            aria-label="Raw terminal"
          />
        }
      />
      <Row
        label="Show thinking"
        hint="On, thought traces sit in the journal as a collapsed duration you can expand, and the live pulse shows the last lines. Off hides the traces and leaves a timer while the agent works."
        htmlFor="pref-thinking"
        control={
          <Switch
            id="pref-thinking"
            checked={prefs.showThinking}
            onCheckedChange={setShowThinking}
            aria-label="Show thinking"
          />
        }
      />
      <Row
        label="Text size"
        control={
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-9"
              disabled={prefs.fontSize <= FONT_MIN}
              onClick={() => stepFontSize(-1)}
              aria-label="Decrease font size"
            >
              <AArrowDown className="size-4" />
            </Button>
            <span className="w-8 text-center font-mono text-xs tabular-nums text-muted-foreground">
              {prefs.fontSize}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-9"
              disabled={prefs.fontSize >= FONT_MAX}
              onClick={() => stepFontSize(1)}
              aria-label="Increase font size"
            >
              <AArrowUp className="size-4" />
            </Button>
          </div>
        }
      />
    </div>
  );
}
