import { Terminal, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { NavTray } from "@/components/nav-tray";
import { DisplayPrefsContent } from "@/components/display-prefs";
import { CommandPalette } from "@/components/command-palette";
import { TerminalDraftPreview } from "@/components/terminal-draft-preview";
import { NoEchoNotice } from "@/components/no-echo-notice";
import { DirectTypingStrip } from "@/components/direct-typing-strip";
import { useDesktop } from "@/lib/desktop";
import { SectionLabel } from "@/components/ui/section-label";

// The composer's rows above the input: the in-flow docks (Keys / Display), the slash-command
// palette, and the three in-flow strips. Split out of composer.tsx — see
// specs/issue-240_split-composer.md. The permanent control row that used to live here is gone; its
// items are rows in the + menu (composer-menu.tsx).
export type ComposerDrawer = "cmd" | "keys" | "display" | null;
// Shared in-flow dock chrome for Keys — an IN-FLOW panel (never an overlay), so the terminal
// mirror's flex-1 box shrinks and its tail stays visible while the dock is open (a covering sheet
// hid exactly the prompt you were driving). Full-bleed top border + capped height keep the mirror
// usable on a phone. The header (title + Close X) is a NON-scrolling child of a flex column; only the
// body below it scrolls (max-h + overflow), so the Close X can never scroll out of reach on a short
// viewport with a tall tray. One wrapper keeps the Keys dock consistent.

export function ComposerDock({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="-mx-3 mb-2 flex flex-col border-t border-border bg-background">
      <div className="flex items-center justify-between px-3 pt-2">
        <SectionLabel>{title}</SectionLabel>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 text-muted-foreground"
          onClick={onClose}
          aria-label={`Close ${title}`}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="max-h-[45dvh] min-h-0 overflow-y-auto">{children}</div>
    </div>
  );
}
export interface ComposerStripsProps {
  preview: { text: string; onTakeOver: (() => void) | null } | null;
  noEcho: {
    prompt: string;
    typed: boolean;
    onUseType: (() => void) | null;
    onDismiss: () => void;
  } | null;
  direct: { show: boolean; onStop: () => void };
  tooLong: boolean;
}
export function ComposerStrips({
  preview,
  noEcho,
  direct,
  tooLong,
}: ComposerStripsProps) {
  return (
    <>
      {tooLong && (
        <>
          {/* A draft too large for the disk tier (lib/drafts.ts). It survives a pane switch — the
              memory tier holds it whole — but not the app closing, and that difference is invisible
              without saying so: the old behaviour silently restored an OLDER, SHORTER draft instead.
              Derived at render rather than pushed through setStatus, because this is a CONDITION that
              lasts as long as the text does, and a status auto-clears in 2.5s and would re-fire on
              every keystroke. Self-clearing: trim the draft or send it and the row is simply gone. */}
          <p className="px-1 pb-1 text-xs leading-snug text-muted-foreground">
            Too long to keep as a saved draft — it survives switching panes, but not closing the app.
          </p>
        </>
      )}
      {preview && (
        <TerminalDraftPreview
          text={preview.text}
          onTakeOver={preview.onTakeOver}
        />
      )}
      {noEcho && (
        <NoEchoNotice
          prompt={noEcho.prompt}
          typed={noEcho.typed}
          onUseType={noEcho.onUseType}
          onDismiss={noEcho.onDismiss}
        />
      )}
      {direct.show && <DirectTypingStrip onStop={direct.onStop} />}
    </>
  );
}
type DrawerProps = {
  drawer: ComposerDrawer;
  onDrawer: (next: ComposerDrawer) => void;
  locked: boolean;
  keys: Pick<
    Parameters<typeof NavTray>[0],
    "presets" | "onSend" | "onQueueChange"
  >;
  display: Parameters<typeof DisplayPrefsContent>[0];
  type: {
    active: boolean;
    disabled: boolean;
    onStart: () => void;
  };
  palette: Pick<
    Parameters<typeof CommandPalette>[0],
    "agent" | "mine" | "onInsert" | "onSubmit"
  >;
};
export function ComposerDrawers({
  drawer,
  onDrawer,
  locked,
  keys,
  display,
  type,
  palette,
}: DrawerProps) {
  const desktop = useDesktop().on;
  return (
    <>
      {/* Keys / Display dock — a single in-flow site above the field, so the panel grows over the
          mirror, not the input. Whichever of the mutually exclusive drawers is active renders here via
          the shared ComposerDock chrome. Keys mounts the NavTray (unmounts on close, so tab/queue reset
          each open); Display mounts the labelled mirror prefs. Agent commands stays a covering
          BottomSheet below (it's a palette, not a pad). All three open from the + menu. */}
      {drawer === "keys" && (
        <ComposerDock title="Keys" onClose={() => onDrawer(null)}>
          <NavTray
            onSend={keys.onSend}
            presets={keys.presets}
            onQueueChange={keys.onQueueChange}
            disabled={locked}
          />
        </ComposerDock>
      )}
      {drawer === "display" && (
        <ComposerDock title="Display" onClose={() => onDrawer(null)}>
          <DisplayPrefsContent {...display} />
          {/* Type, explained. The + menu has the same row as a bare label; this one carries the
              sentence that says what the mode does, next to the other things that change how the
              mirror behaves. Phone only — desktop arms with Ctrl+` or a mirror click. Hidden while
              armed: the + and the strip both carry Stop, and a third one here would be a second,
              worse Stop. */}
          {!desktop && !type.active && (
            <div className="border-t border-border/60 bg-muted/30 px-3 py-1">
              <div className="flex items-center justify-between gap-3 py-1.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Type into terminal</div>
                  <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                    Keys go straight to the pane as you type, Enter included. Use it for password
                    prompts and pickers. Nothing is stored or restored.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 gap-1.5"
                  disabled={type.disabled}
                  aria-label="Start typing into terminal"
                  onClick={() => {
                    // Close the dock FIRST: the mode needs the phone keyboard and the dock is
                    // holding half the viewport. Routed through requestDrawer for the queued-key
                    // discard guard (ADR 0005).
                    onDrawer(null);
                    type.onStart();
                  }}
                >
                  <Terminal className="size-4" />
                  Start
                </Button>
              </div>
            </div>
          )}
        </ComposerDock>
      )}
      <CommandPalette
        open={drawer === "cmd"}
        onClose={() => onDrawer(null)}
        agent={palette.agent}
        mine={palette.mine}
        onInsert={palette.onInsert}
        onSubmit={palette.onSubmit}
      />
    </>
  );
}
