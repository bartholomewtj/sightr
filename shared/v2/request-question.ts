import type { RuntimeRequest, UserInputQuestion } from "./contracts.ts";

// A `question` runtime request as T3's `OrchestrationV2UserInputQuestion` (T17). The bridge writes it
// into the request's `user_input_request` timeline item, and web2's question panel draws from it with
// T3's pendingUserInput logic, so both read the request the same way.
//
// Sightr publishes one step of a multi-question ask at a time (the screen shows only the current
// one), so a request is one question: its id and header come from the current stepper chip. A
// checkbox step is `multiSelect`, with only its boxes as options ("Chat about this" aborts the ask; it
// is not an answer). Each option's `value` is its index in `request.options`, which is what
// `runtime-request.respond` takes back.

/** The `value` of `request.options[index]` in the question. */
export function requestOptionValue(index: number): string {
  return String(index);
}

/** The `request.options` index a question option's value names, or null. */
export function requestOptionIndex(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

/** How many leading options of a checkbox step are its boxes (0 when it is not one). */
export function requestBoxCount(request: Pick<RuntimeRequest, "multiSelect">): number {
  return request.multiSelect?.checked.length ?? 0;
}

export function requestQuestion(
  request: Pick<RuntimeRequest, "prompt" | "options" | "steps" | "multiSelect" | "answers">,
): UserInputQuestion {
  const steps = request.steps ?? [];
  const current = steps.findIndex((s) => s.current);
  const boxes = requestBoxCount(request);
  const options = boxes > 0 ? request.options.slice(0, boxes) : request.options;
  return {
    id: current >= 0 ? `q${current + 1}` : request.answers ? "review" : "q1",
    header: current >= 0 ? steps[current]!.label : request.answers ? "Review" : "Question",
    question: request.prompt,
    options: options.map((o, i) => ({
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
      value: requestOptionValue(i),
    })),
    ...(boxes > 0 ? { multiSelect: true } : {}),
  };
}
