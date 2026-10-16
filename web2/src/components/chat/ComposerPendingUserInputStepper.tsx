// Ported from Sightr v1 web/src/components/wizard-stepper.tsx (T17). Changes: read-only. The chips say
// where a multi-question ask is (answered marks, the current step, the trailing Submit stop), but there
// are no Back/Next chevrons: going back to an earlier question is done in the Terminal tab, and
// answering moves forward. Each step reaches the client as its own request.
import { CheckIcon } from "lucide-react";

import type { RuntimeRequestStep } from "@shared/v2/contracts";
import { cn } from "~/lib/utils";

const CHIP_CLASS = "flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-tight";
const CHIP_CURRENT = "border-you bg-you-soft font-medium text-foreground";
const CHIP_IDLE = "border-border text-muted-foreground";

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
}: {
  steps: readonly RuntimeRequestStep[];
  /** The review step: the trailing Submit stop is the current one. */
  review?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
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
    </div>
  );
}
