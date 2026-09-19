import type { DecisionOption } from "../shared/wire.ts";

export interface DecisionPayload {
  answers: Record<string, string>;
  notes?: string;
}

export function buildDecisionPayload(
  option: DecisionOption,
  opts?: { qid?: string; notes?: string },
): DecisionPayload {
  const qid = opts?.qid ?? "q1";
  let answer: string | undefined;

  if (option.keyLabel && option.keyLabel.trim() !== "") {
    answer = option.keyLabel.trim();
  } else if (option.keys && option.keys.length > 0) {
    const digitKey = option.keys.find((k) => /^\d+$/.test(k));
    if (digitKey !== undefined) {
      answer = digitKey;
    }
  }

  if (answer === undefined) {
    answer = option.label;
  }

  const payload: DecisionPayload = {
    answers: {
      [qid]: answer,
    },
  };

  if (opts?.notes && opts.notes.trim() !== "") {
    payload.notes = opts.notes.trim();
  }

  return payload;
}
