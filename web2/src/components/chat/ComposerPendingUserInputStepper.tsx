// Ported from Sightr v1 web/src/components/wizard-stepper.tsx (T17). The chips say where a
// multi-question ask is (answered marks, the current step, the trailing Submit stop). Back / Next
// chevrons (the terminal's Left / Right) walk the steps without answering: they show when the card is
// given `onBack` / `onNext`, and the request is replaced by the next step's. The first question has
// nothing to its left and the Submit step nothing to its right, so those chevrons are disabled.
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";

import type { RuntimeRequestStep } from "@shared/v2/contracts";
import { cn } from "~/lib/utils";

const CHIP_CLASS = "flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-tight";
const CHIP_CURRENT = "border-you bg-you-soft font-medium text-foreground";
const CHIP_IDLE = "border-border text-muted-foreground";
// 28px keeps the strip slim; the tap area is bled 8px past it so the target is 44px.
const CHEVRON_CLASS =
  "relative flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors outline-none active:bg-muted focus-visible:ring-2 focus-visible:ring-you/40 disabled:opacity-40 after:absolute after:-inset-2 after:content-['']";

/** Where the ask is, said once for screen readers (the chips' `aria-current` alone is rarely read). */
export function stepPosition(steps: readonly RuntimeRequestStep[], review: boolean): string {
  const total = steps.length + 1;
  if (review) return `Step ${total} of ${total}, Submit`;
  const current = steps.findIndex((s) => s.current);
  return current >= 0 ? `Step ${current + 1} of ${total}, ${steps[current]!.label}` : "";
}

export function ComposerPendingUserInputStepper({
  steps,
  review = false,
  locked = false,
  busy = null,
  onBack,
  onNext,
}: {
  steps: readonly RuntimeRequestStep[];
  /** The review step: the trailing Submit stop is the current one. */
  review?: boolean;
  /** A step move or an answer is in flight, or the card cannot answer. */
  locked?: boolean;
  /** Which chevron shows the spinner. */
  busy?: "back" | "next" | null;
  onBack?: () => void;
  onNext?: () => void;
}) {
  const atFirst = !review && (steps[0]?.current ?? false);
  const navigable = onBack !== undefined && onNext !== undefined;
  return (
    <div className="flex items-center gap-1.5">
      {navigable ? (
        <button
          type="button"
          data-step-nav="back"
          aria-label="Previous question"
          disabled={locked || atFirst}
          onClick={onBack}
          className={CHEVRON_CLASS}
        >
          {busy === "back" ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : <ChevronLeftIcon className="size-4" aria-hidden="true" />}
        </button>
      ) : null}
      <span className="sr-only" role="status">
        {stepPosition(steps, review)}
      </span>
      <ol aria-label="Questions" className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {steps.map((step, i) => (
          <li
            key={i}
            aria-current={step.current && !review ? "step" : undefined}
            className={cn(CHIP_CLASS, step.current && !review ? CHIP_CURRENT : CHIP_IDLE)}
          >
            {step.answered ? <CheckIcon className="size-3 shrink-0 text-you" aria-label="Answered" /> : null}
            <span className="truncate">{step.label}</span>
          </li>
        ))}
        <li aria-current={review ? "step" : undefined} className={cn(CHIP_CLASS, review ? CHIP_CURRENT : CHIP_IDLE)}>
          <span>Submit</span>
        </li>
      </ol>
      {navigable ? (
        <button
          type="button"
          data-step-nav="next"
          aria-label={review ? "Next (nothing after Submit)" : "Next question"}
          disabled={locked || review}
          onClick={onNext}
          className={CHEVRON_CLASS}
        >
          {busy === "next" ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : <ChevronRightIcon className="size-4" aria-hidden="true" />}
        </button>
      ) : null}
    </div>
  );
}
