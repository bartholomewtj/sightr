/**
 * Whistlr decision cards (T19). A draftr card marked `whistlr.decision thread=… run=…` arrives as a
 * runtime request with `via: "whistlr"` and its `decision` (T04). It is answered the way v1 answers it:
 * `POST /api/pane/:paneId/decision-reply`, which runs `whistlr reply` on the bridge. Nothing is typed
 * into the pane and `runtime-request.respond` is never posted for it (the bridge refuses that anyway).
 *
 * The tapped option stays busy until the request leaves `pending` (the composer clears `responding`
 * when the card goes). A refusal shows the bridge's own error and keeps the card answerable.
 */
import type { RuntimeRequest } from "@shared/v2/contracts";

import { decisionReply } from "@/lib/api";

import { getThreadComposer, patchComposer } from "./composer";

/** A request answered with `whistlr reply`, never with keys. */
export function isWhistlrDecision(request: Pick<RuntimeRequest, "via">): boolean {
  return request.via === "whistlr";
}

export async function replyToDecision(
  threadId: string,
  paneId: string,
  request: RuntimeRequest,
  optionIndex: number,
): Promise<void> {
  const current = getThreadComposer(threadId).responding;
  if (current && current.requestId === request.id) return;
  const option = request.options[optionIndex];
  if (!option || !request.decision || paneId === "") return;
  patchComposer(threadId, { responding: { requestId: request.id, optionIndex }, verdict: null });
  try {
    const res = await decisionReply(paneId, {
      decision: { thread: request.decision.thread, run: request.decision.run },
      // As v1's prompt-action: the on-screen number is the option's key label (the payload's answer),
      // the label is the reply's text. The card's options keep the screen's order.
      option: { label: option.label, keyLabel: String(optionIndex + 1) },
      question: request.prompt,
    });
    if (res.ok) {
      patchComposer(threadId, { verdict: "Sent with whistlr reply." });
      return;
    }
    patchComposer(threadId, { responding: null, verdict: `whistlr reply failed: ${res.error}` });
  } catch (err) {
    patchComposer(threadId, {
      responding: null,
      verdict: `whistlr reply failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
