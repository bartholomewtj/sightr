// A labelled radio group for the new-thread pickers (T14): arrow keys move and select, Space or Enter
// selects the focused option, and only the selected (or first) option is in the tab order. Options are
// buttons so a tap selects on a phone; `onPick` may refuse a pick (a destructive mode's first tap).
import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface Choice {
  value: string;
  label: ReactNode;
  /** The accessible name when `label` is not plain text. */
  name?: string;
  hint?: ReactNode;
  tone?: "warn";
  disabled?: boolean;
}

export function ChoiceGroup({
  label,
  choices,
  value,
  onPick,
  className,
  variant = "chips",
  labelledBy,
}: {
  label?: string;
  labelledBy?: string;
  choices: readonly Choice[];
  /** The selected value; null when none is selected. */
  value: string | null;
  onPick(value: string): void;
  className?: string;
  variant?: "chips" | "tiles";
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = choices.map((c, i) => (c.disabled ? -1 : i)).filter((i) => i >= 0);
  const selectedIndex = choices.findIndex((c) => c.value === value);
  const tabIndexFor = (i: number) => (i === (selectedIndex >= 0 && !choices[selectedIndex]!.disabled ? selectedIndex : enabled[0]) ? 0 : -1);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
    const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
    if (forward || back) {
      e.preventDefault();
      const at = enabled.indexOf(i);
      const next = enabled[(at + (forward ? 1 : -1) + enabled.length) % enabled.length];
      if (next === undefined) return;
      refs.current[next]?.focus();
      onPick(choices[next]!.value);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onPick(choices[i]!.value);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={cn(variant === "tiles" ? "grid grid-cols-2 gap-2 sm:grid-cols-3" : "flex flex-wrap gap-1.5", className)}
    >
      {choices.map((choice, i) => {
        const checked = choice.value === value;
        return (
          <button
            key={choice.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={choice.name}
            disabled={choice.disabled}
            tabIndex={tabIndexFor(i)}
            onClick={() => onPick(choice.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "rounded-md border text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              variant === "tiles" ? "flex items-start gap-2 p-2.5" : "px-2.5 py-1 text-sm",
              checked ? "border-foreground bg-accent text-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              choice.tone === "warn" && (checked ? "border-warn text-warn" : "text-warn"),
            )}
          >
            {choice.label}
            {choice.hint}
          </button>
        );
      })}
    </div>
  );
}
