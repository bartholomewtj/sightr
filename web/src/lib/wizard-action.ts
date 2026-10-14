// The wizard keystroke (`submitWizardKeys`).
// Split out of lib/actions.ts, which re-exports it (spec 12).

import { type WizardModel } from "./blocks";
import { sendReply } from "./api";
import { guardDialog, pollDialog, readDialog, sendBoundKeys, sendGuardedKeys } from "./dialog-guard";
import { sanitizeTypedText, type Sleep } from "./harness/guard";
import { wizardsSameIdentity } from "./harness/wizard-model";
import { FEEDBACK_MAX_LENGTH, type PromptActionResult } from "./prompt-action";

// The wizard tap: one guarded keystroke against the step currently on screen.
//
// A thin wrapper over the generic race guard (lib/dialog-guard.ts). Under the INCREMENTAL round-trip
// model (harness/claude/wizard.ts) every tap — an option digit, Left/Right navigation, the review
// step's submit/cancel — is ONE keystroke against the step that is there right now, which is exactly
// what makes the guard's re-derivation load-bearing: a wizard that advanced, re-rendered, or vanished
// between render and tap can never match `wizardsEqual` (harness/wizard-model.ts), so the keystroke
// is discarded and the caller refreshes.

/** The wizard identity comparator, part of the neutral contract (harness/wizard-model.ts).
 *  Re-exported under its original name so existing call sites and tests keep one import site. */

/**
 * Run the race guard and, if it passes, send `keys` (one wizard keystroke: an option digit,
 * Left/Right, or the review step's 1/2). Pure of any UI — the caller maps the result to a status
 * message and a revalidation. Result shape shared with actions so AgentChat handles both
 * through one code path.
 */
export async function submitWizardKeys(args: {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered wizard was detected against. */
  detectedRevision: number;
  wizard: WizardModel;
  keys: string[];
  /** The pane's agent — which adapter re-derives the fresh screen. No adapter = the guard refuses. */
  agent?: string;
}): Promise<PromptActionResult> {
  return sendGuardedKeys({ ...args, kind: "wizard", model: args.wizard }, args.keys);
}

/**
 * Type a Pi multi-question custom answer: arrows onto `Type something.` and Enter (opens the
 * editor) → poll until the editor is empty → paste → poll until our words are in it → Enter.
 *
 * Never sends a digit. Refuses while the editor is already open or already holds text — the caret
 * would sit at the front of someone else's sentence. A pointer already on the row is fine: `keys`
 * is then just Enter, and option buttons stay locked so they can't take that Enter by mistake.
 *
 * Mid-flight polls use wizard identity, which ignores the pointer and the editor text. A different
 * question, a flipped check, or a saved custom answer aborts before the submitting Enter.
 */
export async function submitWizardFeedback(args: {
  paneId: string;
  requestedLines: number;
  detectedRevision: number;
  wizard: WizardModel;
  text: string;
  agent?: string;
  sleep?: Sleep;
}): Promise<PromptActionResult> {
  if (args.wizard.phase !== "question") return { status: "changed" };
  const row = args.wizard.feedback;
  if (!row || row.editing || row.text !== "") return { status: "changed" };
  if (row.keys.length === 0 || row.keys.some((k) => /^\d+$/.test(k))) {
    return { status: "error", error: "This dialog's free-text row is not typed from the phone" };
  }
  const text = sanitizeTypedText(args.text, FEEDBACK_MAX_LENGTH);
  if (text.length === 0) return { status: "error", error: "Nothing to send" };

  const target = {
    paneId: args.paneId,
    requestedLines: args.requestedLines,
    detectedRevision: args.detectedRevision,
    agent: args.agent,
    kind: "wizard" as const,
    model: args.wizard,
    sleep: args.sleep,
  };
  const guarded = await guardDialog(target);
  if (!guarded.ok) return guarded.result;

  const open = await sendBoundKeys(args, row.keys, guarded.region);
  if (open.status !== "sent") return open;

  const editorOpen = (m: WizardModel) =>
    wizardsSameIdentity(m, args.wizard) &&
    m.phase === "question" &&
    m.feedback?.editing === true &&
    m.feedback.text === "";
  if ((await pollDialog(target, editorOpen)) !== "ok") {
    return { status: "error", error: "The answer box didn't open — check the pane" };
  }

  try {
    const typed = await sendReply(args.paneId, text, false);
    if (!typed.ok) return { status: "error", error: typed.error };
    const landed = (m: WizardModel) =>
      wizardsSameIdentity(m, args.wizard) &&
      m.phase === "question" &&
      m.feedback?.editing === true &&
      m.feedback.text === text;
    if ((await pollDialog(target, landed)) !== "ok") {
      return { status: "error", error: "The answer didn't arrive — nothing was submitted" };
    }
    const fresh = await readDialog(target);
    if (!fresh.model || !landed(fresh.model)) return { status: "changed" };
    return sendBoundKeys(args, ["Enter"], fresh.model.signature);
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
