import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  Check,
  Paperclip,
  Keyboard,
  Loader2,
  Plus,
  Settings2,
  Slash,
  SquareTerminal,
  Terminal,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { ActionPopover } from "@/components/ui/popover";
import { useDesktop } from "@/lib/desktop";
import type { ComposerDrawer } from "@/components/composer-drawers";

// The round + at the left edge of the reply field, and the menu behind it. It replaced the permanent
// control row (Keys / Type / Agent / Terminal / gear) under the field: six things you reach for a few
// times a session were costing a whole row of a phone viewport every session. Phone: a bottom sheet.
// Desktop: a popover anchored above the button. Every item is a full-width row with an icon and a
// label, and every item closes the menu when chosen.
//
// While direct typing is armed the + is the Stop control instead, mirroring the Send button on the
// other side of the field: the two things you can do in that mode are type and stop, and either
// thumb should find Stop.

export interface ComposerMenuProps {
  /** Pane gone or device read-only: every write item is disabled, Display stays reachable. */
  locked: boolean;
  uploading: boolean;
  direct: { active: boolean; disabled: boolean; onStart: () => void; onStop: () => void };
  showTerminal: boolean;
  onToggleTerminal: () => void;
  /** The pane's agent has slash commands, so "Agent commands" earns a row. */
  hasCommands: boolean;
  onAttach: () => void;
  onDrawer: (next: ComposerDrawer) => void;
}

/** Rough height of the open popover, so the desktop anchor lands the panel ABOVE the button. */
const ROW_PX = 40;
const CHROME_PX = 48;

/** Breathing room above the sheet so its top edge and grab handle never touch the status bar. */
const SHEET_TOP_GAP_PX = 16;

function readVisibleViewport(): { height: number; bottomInset: number } {
  if (typeof window === "undefined") return { height: 0, bottomInset: 0 };
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  const bottomInset = vv
    ? Math.max(0, Math.round(window.innerHeight - (vv.offsetTop + vv.height)))
    : 0;
  return { height, bottomInset };
}

/** The visible viewport while `active`: its height and how far its bottom sits above the layout
 *  viewport's bottom (the iOS keyboard case). Falls back to window.innerHeight / 0. */
function useVisibleViewport(active: boolean): { height: number; bottomInset: number } {
  const [vp, setVp] = useState(readVisibleViewport);

  useLayoutEffect(() => {
    if (!active) return;
    const update = () => setVp(readVisibleViewport());
    update();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active]);

  return vp;
}

export function ComposerMenu({
  locked,
  uploading,
  direct,
  showTerminal,
  onToggleTerminal,
  hasCommands,
  onAttach,
  onDrawer,
}: ComposerMenuProps) {
  const desktop = useDesktop().on;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const vp = useVisibleViewport(open && !desktop);

  // Keys and Type are phone-only: desktop has a physical keyboard and arms direct typing with
  // Ctrl+` or a mirror click. Type also goes while armed, because the + itself is Stop then.
  const showKeys = !desktop;
  const showType = !desktop && !direct.active;
  const rows = 3 + (showKeys ? 1 : 0) + (hasCommands ? 1 : 0) + (showType ? 1 : 0);

  function openMenu() {
    const el = buttonRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      setAnchor({ x: rect.left, y: rect.top - (rows * ROW_PX + CHROME_PX) });
    }
    setOpen(true);
  }

  // Close FIRST and commit it synchronously, then run the action. The sheet restores focus to the +
  // on unmount; if that ran after the action, arming direct typing would focus the textarea and
  // then lose it to the +, and the phone keyboard would never open. flushSync makes the restore
  // happen before the action's own focus, inside the same tap.
  function pick(action: () => void) {
    flushSync(() => setOpen(false));
    action();
  }

  if (direct.active) {
    return (
      <Button
        type="button"
        size="icon"
        className="absolute bottom-1 left-1 size-9 rounded-full border-2 border-you bg-you text-you-foreground hover:bg-you/90"
        onClick={direct.onStop}
        aria-label="Stop typing into terminal"
        aria-pressed
      >
        <X className="size-4" />
      </Button>
    );
  }

  const items = (
    <div className="flex flex-col gap-1">
      <MenuRow
        icon={uploading ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <Paperclip className="size-4 shrink-0" />}
        label="Attach file"
        disabled={uploading || locked}
        onClick={() => pick(onAttach)}
      />
      {showKeys && (
        <MenuRow
          icon={<Keyboard className="size-4 shrink-0" />}
          label="Keys"
          disabled={locked}
          onClick={() => pick(() => onDrawer("keys"))}
        />
      )}
      {hasCommands && (
        <MenuRow
          icon={<Slash className="size-4 shrink-0" />}
          label="Agent commands"
          disabled={locked}
          onClick={() => pick(() => onDrawer("cmd"))}
        />
      )}
      {showType && (
        <MenuRow
          icon={<Terminal className="size-4 shrink-0" />}
          label="Type into terminal"
          disabled={direct.disabled}
          onClick={() =>
            pick(() => {
              // Close any dock first: the mode needs the phone keyboard and a dock holds half the
              // viewport. Routed through requestDrawer for the queued-key discard guard.
              onDrawer(null);
              direct.onStart();
            })
          }
        />
      )}
      {/* Terminal is a toggle, not an action: it flips the live dump on and off and stays on until
          flipped back, so it carries a check mark and aria-checked rather than firing and forgetting.
          Not gated on `locked` — the dump is local view state a read-only device can still open. */}
      <MenuRow
        icon={<SquareTerminal className="size-4 shrink-0" />}
        label="Terminal"
        role="menuitemcheckbox"
        checked={showTerminal}
        onClick={() => pick(onToggleTerminal)}
      />
      {/* Display prefs are local view state too: a read-only device or a gone pane can still make
          its mirror readable. */}
      <MenuRow
        icon={<Settings2 className="size-4 shrink-0" />}
        label="Display"
        onClick={() => pick(() => onDrawer("display"))}
      />
    </div>
  );

  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon"
        // bottom-1, not centred: the field grows upward as the draft wraps, and a centred button would
        // drift up with it, away from the thumb. Pinned to the bottom it stays put at any height.
        className="absolute bottom-1 left-1 size-9 rounded-full text-muted-foreground"
        onClick={openMenu}
        aria-label="More"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Plus className="size-5" />
      </Button>
      {desktop ? (
        <ActionPopover open={open} onClose={() => setOpen(false)} anchor={anchor} title="More">
          {items}
        </ActionPopover>
      ) : (
        /* #367: phone More sheet rows stay on-screen. Slide entrance starts a sheet-height below
           the fold, and the keyboard shrinks the visible viewport but not dvh. Fade in place and cap
           height to visible viewport with a lift above the keyboard. */
        <BottomSheet
          open={open}
          onClose={() => setOpen(false)}
          title="More"
          enter="fade"
          panelStyle={{
            maxHeight: `${Math.max(0, Math.floor(vp.height) - SHEET_TOP_GAP_PX)}px`,
            ...(vp.bottomInset > 0 ? { bottom: `${vp.bottomInset}px` } : {}),
          }}
        >
          {items}
        </BottomSheet>
      )}
    </>
  );
}

// One menu row: icon, label, and for the toggle a trailing check. Same shape as the action sheets'
// ActionRow, plus `disabled` and the checkbox role, so the menu reads like every other sheet.
function MenuRow({
  icon,
  label,
  disabled = false,
  role,
  checked,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  role?: "menuitemcheckbox";
  checked?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === "menuitemcheckbox" ? checked : undefined}
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-accent active:bg-muted disabled:pointer-events-none disabled:opacity-50"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1">{label}</span>
      {checked && <Check className="size-4 shrink-0" aria-hidden="true" />}
    </button>
  );
}
