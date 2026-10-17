// The one-row key bar for direct typing on a phone. With the soft keyboard up there is room for the
// mirror or for the full Keys pad, not both, so typing gets the keys a terminal needs most in a single
// scrolling row and "More" opens the full pad (modifiers, digits, F-keys, presets) on demand.
//
// Every button keeps focus where it is (`preventDefault` on pointer down): a tap must not blur the
// typing box, or the keyboard drops and direct typing disarms. The arrows repeat while held.
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Ellipsis } from "lucide-react";
import type { PointerEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useHoldRepeat } from "@/hooks/use-hold-repeat";

interface KeyBarProps {
  /** Resolves true when the bridge accepted the keys. */
  onSend: (keys: string[]) => Promise<boolean>;
  onMore: () => void;
  disabled?: boolean;
}

const keep = (e: PointerEvent<HTMLElement>) => e.preventDefault();

export function KeyBar({ onSend, onMore, disabled = false }: KeyBarProps) {
  const repeat = useHoldRepeat((key, n) => onSend(Array<string>(n).fill(key)), !disabled);

  const key = (label: ReactNode, keys: string[], aria: string, repeatable = false) => {
    const tap = () => {
      if (!disabled) void onSend(keys);
    };
    const bind = repeatable ? repeat.bind(keys[0]!, tap) : null;
    return (
      <button
        key={aria}
        type="button"
        aria-label={aria}
        disabled={disabled}
        className={cn(
          "inline-flex h-8 min-w-9 shrink-0 items-center justify-center rounded-md border bg-card px-2 font-mono text-xs text-foreground active:bg-accent disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:min-w-11",
          repeat.holding === keys[0] && "bg-accent",
        )}
        {...(bind ?? { onClick: tap })}
        onPointerDown={(e) => {
          keep(e);
          bind?.onPointerDown(e);
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div data-key-bar="" role="toolbar" aria-label="Terminal keys" className="flex items-center gap-1 overflow-x-auto border-t bg-card px-1.5 py-1 [scrollbar-width:none]">
      {key("Esc", ["Escape"], "Escape")}
      {key("Tab", ["Tab"], "Tab")}
      {key(<ArrowLeft className="size-3.5" />, ["Left"], "Left", true)}
      {key(<ArrowUp className="size-3.5" />, ["Up"], "Up", true)}
      {key(<ArrowDown className="size-3.5" />, ["Down"], "Down", true)}
      {key(<ArrowRight className="size-3.5" />, ["Right"], "Right", true)}
      {key("^C", ["ctrl+c"], "Ctrl C")}
      {key(<CornerDownLeft className="size-3.5" />, ["Enter"], "Enter")}
      <button
        type="button"
        aria-label="More keys"
        className="inline-flex h-8 min-w-9 shrink-0 items-center justify-center rounded-md px-2 text-muted-foreground active:bg-accent pointer-coarse:h-11 pointer-coarse:min-w-11"
        onPointerDown={keep}
        onClick={onMore}
      >
        <Ellipsis className="size-4" />
      </button>
    </div>
  );
}
