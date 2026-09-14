// Dialog action recipes: detect the dialog on a fresh screen, then send its keys; free-text replies use the same guard.

import { sendKeys, sendReply, fetchPane } from "./api";
import { parseLines, type MenuModel, type MultiSelectModel, type PreviewOption, type PreviewSelectModel, type PromptModel, type PromptOption, type WizardModel } from "./blocks";
import { guardDialog, pollDialog, readDialog, sendBoundKeys, sendGuardedKeys, type DialogTarget } from "./dialog-guard";
import { adapterFor, type HarnessAdapter } from "./harness";
import { POLL_ATTEMPTS, POLL_DELAY_MS, defaultSleep, sanitizeTypedText, type ActionResult, type Sleep } from "./harness/guard";
import { multiSelectIdentity } from "./harness/multi-select-model";
import { promptsSameIdentity } from "./harness/prompt-model";
import { previewCoreEqual, previewStructureEqual } from "./harness/preview-model";
import { detectNoEchoPrompt } from "./no-echo";
export { menusEqual, menusSameIdentity } from "./harness/menu-model";
export { wizardsEqual } from "./harness/wizard-model";
export { promptsEqual, promptsSameIdentity, sameKeys } from "./harness/prompt-model";
export { previewsEqual } from "./harness/preview-model";
export { multiSelectEquals, multiSelectIdentity } from "./harness/multi-select-model";

// The generic-menu tap — the same guard as its siblings (lib/dialog-guard.ts), with the one
// judgement call this grammar forces:
//
//   - ACTION keys (Enter / s / whatever the footer named) COMMIT. In the `/model` picker, Enter
//     writes the user's default for new sessions. These take the full `commits` comparison — a
//     highlight that moved between render and tap changes the signature, so a stale tap is refused.
//   - NAV keys (Up/Down/Left/Right) only move a highlight. They take the same fresh read but compare
//     the menu's IDENTITY (title + the keys it offers, and NOT the ←/→ row's live label) — because
//     moving the highlight is precisely what changes the signature, so a signature check would make
//     the second arrow tap in a row always fail. Nothing is committed, so identity is enough.
//
// Both semantics live in harness/menu-model.ts (menusEqual / menusSameIdentity) and are wired to this
// kind by harness/dialog-contract.ts; `nav` just picks which one the guard runs.


/** The menu identity comparators, part of the neutral contract (harness/menu-model.ts). Re-exported
 *  under their original names so existing call sites and tests keep one import site. */

/**
 * Run the guard and, if it passes, send `keys`. `nav: true` selects the identity-only comparison for
 * a non-committal arrow key (see the header). Pure of any UI — the caller maps the result to a
 * status message and a revalidation.
 */
export async function submitMenuKeys(args: {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered menu was detected against. */
  detectedRevision: number;
  menu: MenuModel;
  keys: string[];
  /** True for Up/Down/Left/Right: compare identity only, since the tap's own effect is the change. */
  nav?: boolean;
  /** The pane's agent — which adapter re-derives the fresh screen. No adapter = the guard refuses. */
  agent?: string;
}): Promise<ActionResult> {
  return sendGuardedKeys(
    { ...args, kind: "menu", model: args.menu },
    args.keys,
    args.nav ? "identity" : "commits",
  );
}

// The wizard tap: one guarded keystroke against the step currently on screen.
//
// A thin wrapper over the generic race guard (lib/dialog-guard.ts). Under the INCREMENTAL round-trip
// model (grammar/WIZARD_NOTES.md) every tap — an option digit, Left/Right navigation, the review
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

// The prompt-select action recipes — the generic race guard (lib/dialog-guard.ts) plus, for the one
// dialog that carries an inline text input, the extra verified steps its MULTI-step choreography
// needs (grammar/PLAN_FEEDBACK_NOTES.md):
//
//   - Answering an option is the digit alone (or digit+Enter for the `select` family): one guarded
//     write, nothing to sequence.
//   - Sending FEEDBACK on a plan is the input row's digit → verify the field focused → type → Enter.
//     The digit does not answer anything; it moves `❯` onto the row and focuses the field, after
//     which the dialog routes every keystroke into the box as text. Enter then submits the box as
//     DENY-WITH-FEEDBACK: the plan is rejected, the agent is handed the text and re-plans. That Enter
//     is irreversible and it is the LAST thing sent, only after a fresh read shows our own words in
//     the box — the same "never submit blind" rule as actions and submitPreviewNote.
//
// Both flows start with the same guard as their siblings: a FRESH pane read, the unconditional
// revision check, and a re-derivation THROUGH THE PANE'S ADAPTER compared against what the user
// tapped. The mid-flight polls re-derive the same way, against `promptsSameIdentity` — the feedback
// flow moves the pointer and fills the input by design, so `promptsEqual` would reject its own work.


/** The prompt-select identity comparators, part of the neutral contract (harness/prompt-model.ts).
 *  Re-exported under their original names so existing call sites and tests keep one import site. */

/** The guarded-action result union, canonical in `harness/guard.ts`; re-exported under the original
 *  name so existing imports (actions, AgentChat, tests) keep working. */
export type PromptActionResult = ActionResult;

/**
 * Longest feedback Sightr will type into a plan dialog.
 *
 * Not a comfort limit — a grammar one. The row does not window long text: Claude re-flows the whole
 * value across as many display lines as it needs, which pushes the dialog's footer away from its
 * options. `MAX_FEEDBACK_WRAP` (harness/claude/prompt-select.ts) is how far that may go before the
 * screen stops parsing at all, and this is sized to stay inside it even on a narrow pane (~4 lines of
 * ~60 usable columns). Longer text isn't dangerous — the read-back check simply refuses and nothing is
 * submitted — but the dialog would drop off the phone, so we don't let it happen.
 */
export const FEEDBACK_MAX_LENGTH = 240;

interface PromptGuardArgs {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered menu was detected against. */
  detectedRevision: number;
  prompt: PromptModel;
  /** The pane's agent — which adapter re-derives the fresh screen. No adapter = the guard refuses. */
  agent?: string;
  /** Test seam for the verification polls' pacing. */
  sleep?: Sleep;
}

/** This module's slice of the generic guard: the prompt dialog the tap is aimed at. */
function promptTarget(args: PromptGuardArgs): DialogTarget<"prompt-select"> & { sleep?: Sleep } {
  return { ...args, kind: "prompt-select", model: args.prompt };
}

/**
 * Run the race guard and, if it passes, send `option.keys`. Pure of any UI — the caller maps the
 * result to a status message and a revalidation.
 *
 * Refuses outright while the dialog's own input row has FOCUS: the terminal then swallows every digit
 * as a character, so the keystroke would silently type into someone's half-written sentence instead
 * of answering (collie#95).
 *
 * This is NOT a duplicate of the renderer's lock, and not belt-and-braces — it is the only thing at
 * the write layer that refuses the STATE. The race guard below verifies SAMENESS: a model captured
 * while focused, compared against a fresh screen that is still focused, compares EQUAL and the digit
 * goes out. The renderer's lock is UX; this is the invariant. Don't remove it as redundant.
 */
export async function submitPromptOption(
  args: PromptGuardArgs & { option: PromptOption },
): Promise<PromptActionResult> {
  if (args.prompt.feedback?.focused) return { status: "changed" };
  return sendGuardedKeys({ ...args, kind: "prompt-select", model: args.prompt }, args.option.keys);
}

/**
 * Deny the plan WITH feedback: entry guard → the input row's digit → poll until the field is
 * verifiably focused → type via the reply path (one paste; immune to the per-key focus race) → poll
 * until our own words are visibly in the box → Enter.
 *
 * Refused before anything is sent unless the box is EMPTY and unfocused. Two different hazards:
 *   - focused already — someone at the terminal is typing in it right now;
 *   - non-empty — re-entering the field puts the caret at position 0 (measured), so our text would be
 *     PREPENDED to theirs and the Enter would submit the pair as one garbled sentence. Backspace at
 *     position 0 is a no-op, so there is no safe clear from here either. The phone waits instead.
 *
 * If focus never lands, nothing has been typed and nothing is submitted — the digit's pointer move is
 * the only side effect, and `Up` (from the keys pad, or the terminal) undoes it. If the text never
 * lands, NO Enter is sent: the words sit unsubmitted in the box for a human to finish or discard,
 * which is the same bargain actions's `stalled` strikes.
 */
export async function submitPromptFeedback(
  args: PromptGuardArgs & { text: string },
): Promise<PromptActionResult> {
  const row = args.prompt.feedback;
  if (!row || row.focused || row.text !== "") return { status: "changed" };
  // Grok's `z` row is a custom answer, not Claude's deny-with-feedback input. The sequence
  // below (digit → focus → type → Enter) was measured on Claude Code; running it on a
  // free-text row would send the wrong key and the wrong Enter. The phone locks the option
  // buttons while that row is focused and leaves typing to the terminal.
  if (row.purpose === "free-text") {
    return { status: "error", error: "This dialog's free-text row is not typed from the phone" };
  }
  const text = sanitizeTypedText(args.text, FEEDBACK_MAX_LENGTH);
  if (text.length === 0) return { status: "error", error: "Nothing to send" };

  const guarded = await guardDialog(promptTarget(args));
  if (!guarded.ok) return guarded.result;

  // Bind this write to the guarded region. It moves focus, so the steps after it must re-derive
  // rather than reuse this binding.
  const focus = await sendBoundKeys(args, [row.key], guarded.region);
  if (focus.status !== "sent") return focus;

  // The field must be FOCUSED, and STILL EMPTY, before anything is typed. Focus alone is not enough:
  // this flow runs while a human is looking at the same dialog, so the window between our digit and
  // our paste is exactly when they might start typing into the box themselves. Their fragment would
  // sit at the head, our paste would follow it, and the tail-windowed read-back below cannot see a
  // prefix — so the Enter would submit both as one garbled sentence. The note flow solves this by
  // clearing first; this row cannot be cleared (Backspace at position 0 is a no-op), so refusing on a
  // non-empty box is the substitute. It narrows the shared-PTY window to one read-to-write round
  // trip, which is irreducible. On timeout we stop dead: nothing has been typed.
  const focusedAndEmpty = (m: PromptModel) =>
    promptsSameIdentity(m, args.prompt) && (m.feedback?.focused ?? false) && m.feedback?.text === "";
  if ((await pollDialog(promptTarget(args), focusedAndEmpty)) !== "ok") {
    return { status: "error", error: "The feedback box didn't open — check the pane" };
  }

  try {
    const typed = await sendReply(args.paneId, text, false);
    if (!typed.ok) return { status: "error", error: typed.error };
    // Wait for our words to render, then match them EXACTLY. The row re-flows rather than windowing,
    // and the grammar rejoins its wrapped lines, so the whole value is readable — there is no reason to
    // accept a partial match, and every reason not to: this is the evidence the irreversible Enter is
    // sent on. Anything the terminal did to our text that we can't account for (a mid-word wrap seam, a
    // truncation) shows up as inequality and stops the flow with the box unsubmitted.
    const landed = (m: PromptModel) =>
      promptsSameIdentity(m, args.prompt) &&
      (m.feedback?.focused ?? false) &&
      m.feedback?.text === text;
    if ((await pollDialog(promptTarget(args), landed)) !== "ok") {
      return { status: "error", error: "The feedback didn't arrive — nothing was submitted" };
    }
    // The Enter is the only irreversible write in this flow — it rejects a plan and puts words in the
    // agent's mouth — so it is also the one that must not go out unbound. Re-read, re-check, and hand
    // the bridge the region it must still find before writing: a keystroke at the terminal between
    // that read and this write then produces a server-side refusal instead of a submit aimed at a
    // screen that has moved. (The sibling flows send their last key unbound; this one carries more.)
    const fresh = await readDialog(promptTarget(args));
    if (!fresh.model || !landed(fresh.model)) return { status: "changed" };
    return sendBoundKeys(args, ["Enter"], fresh.model.signature);
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

// The preview-variant action recipes — the generic race guard (lib/dialog-guard.ts) plus the extra
// verified steps this dialog's MULTI-step choreography needs (grammar/NOTES_NOTES.md):
//
//   - Selecting an option is digit → verify pointer → Enter. A `[digit, Enter]` pair in ONE
//     send_keys call picks the WRONG row (the TUI processes both keys in one input chunk and the
//     Enter still sees the pre-digit pointer — observed live), so the Enter is only sent after a
//     fresh read shows the pointer on the tapped row.
//   - Adding/editing a note is n → verify the input focused → clear → type → Escape. Focus is not
//     instantaneous, keystrokes sent early are misrouted, and Enter inside the input would submit
//     the dialog — so every step that types is gated on a verified pane state, and Enter is never
//     part of the recipe.
//
// Every flow starts with the same guard as its siblings (lib/dialog-guard.ts): a FRESH pane read, the
// unconditional revision check, and a re-derivation THROUGH THE PANE'S ADAPTER compared against what
// the user tapped (Herdr 0.7.x's revision is a stub — the re-derivation is the load-bearing check).
// The mid-flight verification polls re-derive the same way; a dialog that drifts structurally at any
// point aborts with "changed" BEFORE anything irreversible is sent. The two comparators the polls use
// (`previewsEqual` for the entry, `previewCoreEqual` for the mid-flight identity) are the neutral
// contract in harness/preview-model.ts, wired to this kind by harness/dialog-contract.ts.


/** This module's slice of the generic guard: the preview dialog the tap is aimed at. */
function previewTarget(args: PreviewGuardArgs): DialogTarget<"preview-select"> & { sleep?: Sleep } {
  return { ...args, kind: "preview-select", model: args.preview };
}

/** Longest note Sightr will type (the editor enforces it). The TUI itself windows the display at
 *  ~60 columns, so long notes can't be read back faithfully anyway — keep them phone-sized. */
export const NOTE_MAX_LENGTH = 300;
// The deterministic clear for an existing note: ctrl+k kills cursor→end, the Backspace sweep kills
// the head (surplus presses at position 0 are no-ops). Sized past NOTE_MAX_LENGTH so any note
// Sightr itself attached is always fully cleared; ctrl+u/ctrl+a are NOT supported by the input.
const CLEAR_SWEEP = NOTE_MAX_LENGTH + 20;

/** The preview identity comparators, part of the neutral contract (harness/preview-model.ts).
 *  Re-exported under the original name so existing call sites and tests keep one import site. */

interface PreviewGuardArgs {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered dialog was detected against. */
  detectedRevision: number;
  preview: PreviewSelectModel;
  /** The pane's agent — which adapter re-derives the fresh screen. No adapter = the guard refuses. */
  agent?: string;
  /** Test seam for the verification polls' pacing. */
  sleep?: Sleep;
}

/**
 * Select an option: entry guard → digit (pointer move) → poll until the pointer verifiably sits on
 * the tapped row → Enter. If the pointer never converges nothing has been submitted — the digit's
 * pointer move is the only side effect — so the caller just refreshes.
 */
export async function submitPreviewOption(
  args: PreviewGuardArgs & { option: PreviewOption },
): Promise<ActionResult> {
  const guarded = await guardDialog(previewTarget(args));
  if (!guarded.ok) return guarded.result;

  try {
    // Bind only this first write. It changes the dialog, so later steps must not reuse this region.
    const digit = await sendKeys(
      args.paneId,
      [String(args.option.n)],
      guarded.region,
    );
    if (!digit.ok && digit.code === "prompt_changed") return { status: "changed" };
    if (!digit.ok) return { status: "error", error: digit.error };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  const pointed = await pollDialog(
    previewTarget(args),
    (m) =>
      previewStructureEqual(m, args.preview) && // same dialog, note untouched (an open input eats keys)
      (m.options.find((o) => o.n === args.option.n)?.pointed ?? false),
  );
  if (pointed !== "ok") return { status: "changed" };

  try {
    const enter = await sendKeys(args.paneId, ["Enter"]);
    if (!enter.ok) return { status: "error", error: enter.error };
    return { status: "sent" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Attach, replace, or remove (empty `text`) the question's note: entry guard → `n` → poll until
 * the note input is verifiably focused → clear (when replacing) → type via the reply path (one
 * agent.send paste — immune to the per-key focus race) → Escape (blur, keep; never Enter, which
 * would submit the dialog). The entry guard also rejects while the input is ALREADY focused
 * (a terminal user is typing there — our keys would corrupt their note).
 *
 * EVERY stage is verified rendered before the next is sent, and the final blur is verified too
 * (with one retry): an Escape written on the heels of the paste can land in the same input chunk,
 * where the bare ESC byte is misparsed and swallowed (observed live) — the render round-trip
 * between stages is what guarantees each write arrives as its own clean chunk.
 */
export async function submitPreviewNote(
  args: PreviewGuardArgs & { text: string },
): Promise<ActionResult> {
  if (args.preview.note.state === "editing") return { status: "changed" };
  const guarded = await guardDialog(previewTarget(args));
  if (!guarded.ok) return guarded.result;

  const text = sanitizeTypedText(args.text, NOTE_MAX_LENGTH);
  const editing = (m: PreviewSelectModel) =>
    previewCoreEqual(m, args.preview) && m.note.state === "editing";

  try {
    // Bind only this first write. It changes the dialog, so later steps must not reuse this region.
    const open = await sendKeys(args.paneId, ["n"], guarded.region);
    if (!open.ok && open.code === "prompt_changed") return { status: "changed" };
    if (!open.ok) return { status: "error", error: open.error };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  // The input must be FOCUSED before anything else is sent — early keys are misrouted (verified).
  // On timeout we stop dead: a blind Escape could cancel the whole dialog if `n` never landed.
  if ((await pollDialog(previewTarget(args), editing)) !== "ok") {
    return { status: "error", error: "Note input didn't open — check the pane" };
  }

  try {
    if (args.preview.note.state === "attached") {
      // Deterministic clear: the restored cursor position is unreliable, so kill the tail from
      // wherever it is, then sweep the head with Backspaces (no-ops once the text is gone). Then
      // wait until the input verifiably shows empty before typing into it.
      const clear = await sendKeys(
        args.paneId,
        ["ctrl+k", ...Array.from({ length: CLEAR_SWEEP }, () => "Backspace")],
      );
      if (!clear.ok) return { status: "error", error: clear.error };
      if (
        (await pollDialog(previewTarget(args), (m) => editing(m) && m.note.text === "")) !== "ok"
      ) {
        return { status: "error", error: "Couldn't clear the existing note — check the pane" };
      }
    }
    if (text.length > 0) {
      const typed = await sendReply(args.paneId, text, false);
      if (!typed.ok) return { status: "error", error: typed.error };
      // Wait for the text to render. The input windows long text around the trailing cursor, so
      // the visible value is the TAIL of what we typed (the whole of it when it fits).
      const landed = await pollDialog(
        previewTarget(args),
        (m) => editing(m) && m.note.text.length > 0 && text.endsWith(m.note.text),
      );
      if (landed !== "ok") {
        return { status: "error", error: "Note text didn't arrive — check the pane" };
      }
    }
    // Blur, keeping the text. Verified (the swallowed-ESC hazard above). The ONLY safe reason to
    // resend Escape is a swallowed key while OUR dialog is still on screen and still editing (a
    // "timeout" — the ESC glued onto the paste chunk). If instead the dialog DRIFTED or VANISHED
    // (a successor dialog, or a now-running agent — pollUntil returns "drifted"), a second blind
    // Escape would cancel/interrupt whatever is there now — so abort with "changed" and send nothing.
    for (let attempt = 0; attempt < 2; attempt++) {
      const blur = await sendKeys(args.paneId, ["Escape"]);
      if (!blur.ok) return { status: "error", error: blur.error };
      const blurred = await pollDialog(
        previewTarget(args),
        (m) => previewCoreEqual(m, args.preview) && m.note.state !== "editing",
      );
      if (blurred === "ok") return { status: "sent" };
      if (blurred === "drifted") return { status: "changed" }; // no second Escape at a successor
      // "timeout": our dialog is still editing — the ESC was likely swallowed. Retry once.
    }
    return { status: "error", error: "Note input didn't close — check the pane" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * One guarded keystroke against the dialog (the wizard step's Left/Right navigation) — the exact
 * shape of submitWizardKeys, but re-deriving the PREVIEW model.
 */
export async function submitPreviewKeys(
  args: PreviewGuardArgs & { keys: string[] },
): Promise<ActionResult> {
  const guarded = await guardDialog(previewTarget(args));
  if (!guarded.ok) return guarded.result;
  try {
    // Bind only this first write. It changes the dialog, so later steps must not reuse this region.
    const res = await sendKeys(args.paneId, args.keys, guarded.region);
    if (!res.ok && res.code === "prompt_changed") return { status: "changed" };
    if (!res.ok) return { status: "error", error: res.error };
    return { status: "sent" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

// The multi-select action recipes — the generic race guard (lib/dialog-guard.ts) plus the extra
// verified steps this dialog needs, because its Submit is a CLOSED-LOOP choreography (never a blind
// Enter):
//
//   - A digit TOGGLES its option on/off (pointer-independent, deterministic). "Chat about this"
//     aborts the tool. The review screen's 1/2 submit/cancel. Each of these is one guarded keystroke.
//   - Submit (checkbox → review) is the hard case: Enter activates the POINTED row, NOT a global
//     submit, and Down CLAMPS at the bottom ("Chat about this") with "Submit" exactly one row above
//     it. So the deterministic macro is: clamp Down to the bottom → Up once → VERIFY the pointer sits
//     on "Submit" → only then Enter. The pointer is re-derived from a fresh read at every step, so a
//     checkbox flip / dialog change mid-macro aborts BEFORE any Enter.
//
// Every flow starts with the same entry guard as the sibling actions (lib/dialog-guard.ts): a FRESH
// pane read, the unconditional revision check, and a re-derivation THROUGH THE PANE'S ADAPTER compared
// against what the user tapped (Herdr 0.7.x's revision is a stub — the re-derivation is the
// load-bearing check). The mid-flight reads re-derive the same way, keyed on the
// pointer-independent-but-not-checkbox-independent `multiSelectIdentity` so the macro's own Down/Up
// moves don't read as drift while a box flipped by another device does. Both comparators are the
// neutral contract in harness/multi-select-model.ts, wired to this kind by harness/dialog-contract.ts.


/** One tap's intent, resolved to keystrokes by {@link submitMultiSelectIntent}. Shared with the
 *  MultiSelectBlock renderer (its `onAction` emits exactly these). */
export type MultiSelectIntent =
  | { kind: "toggle"; n: number } // checkbox: toggle option n on/off
  | { kind: "escape" } //            checkbox: "Chat about this" — aborts the tool
  | { kind: "advance" } //           checkbox: the closed-loop Down→Up→verify→Enter macro onto the
  //                                 advance row ("Submit" on the last question, "Next" before it)
  | { kind: "nav"; keys: string[] } // checkbox step of a wizard: Left/Right to another question
  | { kind: "confirm" } //           review: submit the answers (digit 1)
  | { kind: "cancel" }; //           review: back to the checkboxes (digit 2)

/** The multi-select identity comparators, part of the neutral contract
 *  (harness/multi-select-model.ts). Re-exported under their original names so existing call sites and
 *  tests keep one import site. */

interface MultiGuardArgs {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered dialog was detected against. */
  detectedRevision: number;
  multi: MultiSelectModel;
  /** The pane's agent — which adapter re-derives the fresh screen. No adapter = the guard refuses. */
  agent?: string;
  /** Test seam for the verification polls' pacing. */
  sleep?: Sleep;
}

/** This module's slice of the generic guard: the multi-select dialog the tap is aimed at. */
function multiTarget(args: MultiGuardArgs): DialogTarget<"multi-select"> {
  return { ...args, kind: "multi-select", model: args.multi };
}

// Per-pane serialization of multi-select actions WITHIN this browser context. The Submit macro is a
// multi-step, ~1-2s choreography (walk the pointer, re-reading each step); the single-keystroke
// intents are quick but still a read + a send. Without a mutex, two overlapping calls on the SAME
// pane can interleave dangerously — the acute case: two Submit macros both reaching "pointer on
// Submit" and both sending Enter, where the FIRST lands on the review screen (its pointer already on
// "1. Submit answers") and the SECOND Enter activates it, submitting WITHOUT the user seeing review.
// Two ways in: two devices on one herd, or one device where a mid-redraw briefly unmounts+remounts
// the block and clears its local `sending` lock, inviting a re-tap. A module-scoped in-flight set
// closes the single-device path outright and shrinks the multi-device path to the irreducible
// read→send window (fully closing it would need server-side coordination — out of scope). An overlap
// is rejected as "changed" so the caller simply revalidates onto the fresh state.
const inFlight = new Set<string>();

/**
 * Dispatch a multi-select intent through the race guard, serialized per pane. Toggle/escape/confirm/
 * cancel are one guarded keystroke each; submit is the closed-loop macro. Pure of any UI — the caller
 * maps the result to a status message + a revalidation. A second call on a pane already mid-action (in
 * this browser context) is rejected as "changed" without touching the terminal.
 */
export async function submitMultiSelectIntent(
  args: MultiGuardArgs & { intent: MultiSelectIntent },
): Promise<ActionResult> {
  const key = args.paneId;
  if (inFlight.has(key)) return { status: "changed" }; // a sibling action holds this pane
  inFlight.add(key);
  try {
    return await dispatchIntent(args);
  } finally {
    inFlight.delete(key);
  }
}

/** Resolve one intent to its guarded keystroke(s). Runs with the per-pane lock held. */
async function dispatchIntent(
  args: MultiGuardArgs & { intent: MultiSelectIntent },
): Promise<ActionResult> {
  const { intent } = args;
  if (intent.kind === "advance") {
    if (args.multi.phase === "checkbox" && args.multi.recipe === "tab-space-enter") {
      return guardedKey(args, args.multi.parked ? ["Tab", "Enter"] : ["Enter"]);
    }
    return runAdvanceMacro(args);
  }
  if (intent.kind === "toggle") {
    // Validate the tapped option against the CURRENT model BEFORE the guard reads: a renderer that
    // emits an out-of-range / non-option `n` must never inject a stray key into the live terminal.
    if (args.multi.phase !== "checkbox" || !args.multi.options.some((o) => o.n === intent.n)) {
      return { status: "changed" };
    }
    if (args.multi.recipe === "tab-space-enter") return runTabSpaceToggle(args, intent.n);
    return guardedKey(args, [String(intent.n)]);
  }
  if (intent.kind === "nav") {
    // Only a wizard STEP has anywhere to navigate to; a standalone multiSelect has no siblings.
    if (args.multi.phase !== "checkbox" || !args.multi.steps) return { status: "changed" };
    return guardedKey(args, intent.keys);
  }
  if (intent.kind === "escape") {
    if (args.multi.phase !== "checkbox" || !args.multi.escape) return { status: "changed" };
    return guardedKey(args, [String(args.multi.escape.n)]);
  }
  if (intent.kind === "confirm") {
    if (args.multi.phase !== "review") return { status: "changed" };
    return guardedKey(args, ["1"]);
  }
  // cancel
  if (args.multi.phase !== "review") return { status: "changed" };
  return guardedKey(args, ["2"]);
}

/** Entry guard, then send exactly `keys` (one keystroke against the dialog). */
async function guardedKey(args: MultiGuardArgs, keys: string[]): Promise<ActionResult> {
  const guarded = await guardDialog(multiTarget(args));
  if (!guarded.ok) return guarded.result;
  return sendBoundKeys(args, keys, guarded.region);
}

// The pointer settles fast after a nav key — a pointer move is a cheap redraw, unlike the note-focus
// race the 350ms POLL_DELAY guards — so the Submit walk re-reads on this short cadence and advances
// one row per read. (The old macro polled for "reached the bottom" AFTER every Down, so each
// intermediate step burned the full ~2.8s poll timeout before giving up and stepping again — a
// ~5-row walk stalled ~15s. Re-reading the actual pointer resolves each step in one settle.)
const NAV_SETTLE_MS = 250;

/**
 * Grok checkbox toggle: Tab until the highlight sits on option `n`, then Space. Digits submit
 * on that widget (ASK_NOTES.md) — this path must never send one. Each Tab re-reads `focusedN`
 * (the colour highlight). Space is the last key; identity includes `checked`, so a flip by
 * another device aborts the walk before Space. A parked card (`Tab/Space:question`) gets one
 * extra Tab first — that footer's named key re-enters; Space before that is a no-op.
 */
async function runTabSpaceToggle(args: MultiGuardArgs, n: number): Promise<ActionResult> {
  if (args.multi.phase !== "checkbox" || args.multi.recipe !== "tab-space-enter") {
    return { status: "changed" };
  }
  const guarded = await guardDialog(multiTarget(args));
  if (!guarded.ok) return guarded.result;

  const sleep = args.sleep ?? defaultSleep;
  const maxSteps = args.multi.options.length + 3;
  let expectedPrompt: string | undefined = guarded.region;
  const sendMacroStep = async (keys: string[]) => {
    const expected = expectedPrompt;
    expectedPrompt = undefined;
    const res = await sendBoundKeys(args, keys, expected);
    return res.status === "sent" ? null : res;
  };

  if (args.multi.parked) {
    const sent = await sendMacroStep(["Tab"]);
    if (sent) return sent;
    await sleep(NAV_SETTLE_MS);
  }

  for (let step = 0; step < maxSteps; step++) {
    let fresh;
    try {
      fresh = await readDialog(multiTarget(args));
    } catch {
      await sleep(NAV_SETTLE_MS);
      continue;
    }
    const m = fresh.model;
    if (!m) {
      await sleep(NAV_SETTLE_MS);
      continue;
    }
    if (!multiSelectIdentity(m, args.multi) || m.phase !== "checkbox") return { status: "changed" };
    if (m.recipe !== "tab-space-enter") return { status: "changed" };
    if (m.focusedN === n) {
      return (await sendMacroStep(["Space"])) ?? { status: "sent" };
    }
    const sent = await sendMacroStep(["Tab"]);
    if (sent) return sent;
    await sleep(NAV_SETTLE_MS);
  }
  return { status: "changed" };
}

/**
 * The Submit macro (checkbox → review): entry guard → walk the pointer DOWN onto "Submit" → Enter.
 * Each step re-reads the ACTUAL pointer and stops the INSTANT it lands on "Submit" — which sits just
 * above the bottom "Chat about this" row, so a downward walk reaches it first (no overshoot, no
 * back-up). Enter is NEVER sent without a fresh read confirming the pointer is on "Submit", and every
 * read re-checks the dialog IDENTITY, so a drift / a checkbox screen that already advanced / a
 * vanished dialog aborts BEFORE any key. Reaching the review screen re-renders on the next poll, where
 * the user confirms (we do NOT auto-send "1").
 */
async function runAdvanceMacro(args: MultiGuardArgs): Promise<ActionResult> {
  if (args.multi.phase !== "checkbox") return { status: "changed" };
  const guarded = await guardDialog(multiTarget(args));
  if (!guarded.ok) return guarded.result;

  const sleep = args.sleep ?? defaultSleep;
  // Bound the walk: enough nudges to cross every navigable row (options + free-text + Submit + Chat)
  // with slack for a couple of swallowed keys, so a wedged pane can't loop forever.
  const maxSteps = args.multi.options.length + 6;
  // Bind only the first write. The macro intentionally changes the dialog step by step, so reusing
  // the original region would reject every valid later step. Enter stays protected by the identity
  // check that runs before every macro write.
  let expectedPrompt: string | undefined = guarded.region;
  const sendMacroStep = async (keys: string[]) => {
    const expected = expectedPrompt;
    expectedPrompt = undefined;
    const res = await sendBoundKeys(args, keys, expected);
    return res.status === "sent" ? null : res;
  };

  for (let step = 0; step < maxSteps; step++) {
    let fresh;
    try {
      fresh = await readDialog(multiTarget(args));
    } catch {
      await sleep(NAV_SETTLE_MS); // transient read failure — re-read within the bounded walk
      continue;
    }
    const m = fresh.model;
    if (!m) {
      await sleep(NAV_SETTLE_MS); // TUI mid-redraw hid the tail — re-read without sending a key
      continue;
    }
    // Drift guard: a successor dialog, or the checkbox screen already gone — abort before any key.
    if (!multiSelectIdentity(m, args.multi) || m.phase !== "checkbox") return { status: "changed" };
    if (m.pointer === "advance") {
      // Verified on the advance row: activate it. What appears next — the following question of a
      // wizard, or the review screen — is re-detected by whichever grammar owns it on the next poll.
      // This macro deliberately does not predict another screen's shape.
      return (await sendMacroStep(["Enter"])) ?? { status: "sent" };
    }
    // Nudge toward the advance row: Down for every row above it (options / free-text / none), and Up
    // on the off chance the pointer starts on the bottom "Chat about this" row (advance is above it).
    const sent = await sendMacroStep([m.pointer === "chat" ? "Up" : "Down"]);
    if (sent) return sent;
    await sleep(NAV_SETTLE_MS);
  }
  // Never landed on the advance row within the bounded walk — refresh rather than blind-send.
  return { status: "changed" };
}

// The free-text reply path's race guard.
//
// Every OTHER path that types into a live TUI (prompt-, wizard-, actions) refuses to send a
// key it hasn't first verified the pane is ready for — "Enter is never sent blind". The reply path
// was the one exception: it typed the text, waited a fixed 350ms, and fired the submit key with
// nothing checking what was on screen.
//
// That is collie#34, reproduced on a real pane: with a Claude permission dialog focused, the typed
// text is swallowed and the submit key ANSWERS THE DIALOG — approving whatever option was
// highlighted (Claude highlights "Yes" by default). The message is destroyed and the bridge still
// reports {ok:true}, because both Herdr RPCs genuinely succeeded: an ack means "herdr took the
// bytes" (HERDR_API.md), never "the TUI acted on them". So the bridge cannot detect this; only a
// client that can read the input box can.
//
// The fix makes the submit key CONDITIONAL on evidence the text reached the input box: type
// unsubmitted → poll fresh reads until the adapter sees our text on the "❯" line → only then
// submit. If it never appears, NO key is sent and the caller keeps the draft. This is the same
// choreography submitPreviewNote already uses for the note field, applied to the main input.


export type ReplyOutcome =
  /** Text was verified in the input box and the submit key went through. */
  | { status: "sent" }
  /**
   * The PRE-FLIGHT refused: a live read could not see an input box on screen, so NO REPLY TEXT was
   * typed and no submit key was sent. Distinct from `stalled`, which is reported only after the text
   * has already gone into the pane. The caller keeps the draft and may offer a deliberate override
   * (`force`). The caller's `onComposerSeen` work may have run before a re-confirming refusal — but
   * only ever on the path where a live read had just seen the composer, which is the invariant that
   * whole callback exists to enforce.
   *
   * `noEcho` carries the password prompt the refusing read was looking at, when it was one — see
   * lib/no-echo.ts.
   */
  | { status: "blocked"; error: string; noEcho?: string }
  /** Text never reached the input box — NO submit key was sent. The caller MUST keep the draft.
   *  `noEcho`: the prompt the last verification read saw, when the reason the text never appeared is
   *  that the screen is deliberately not showing it — see lib/no-echo.ts. */
  | { status: "stalled"; error: string; noEcho?: string }
  /** Transport/RPC failure. `textDelivered` = text is in the pane but unsubmitted; don't resend. */
  | { status: "error"; error: string; textDelivered?: boolean };

/** Minimum visible characters that must match before we believe the input box holds OUR text. */
const MIN_MATCH_CHARS = 8;

const REGEXP_META = /[.*+?^${}()|[\]\\]/g;

/** The exact gap extractInputDraft's fold inserts at a wrap seam: one plain space, always. Any
 *  other gap on screen is whitespace the operator really typed, so `sent` must carry it too. */
const FOLD_SEAM = " ";

/** `Intl.Segmenter` is the newest platform API anything in this bundle depends on (Firefox 125,
 *  Safari 14.1), and this module is in the main chunk — composer.tsx imports it eagerly, so a
 *  module-scope `new Intl.Segmenter` on an engine without it throws at evaluation and white-screens
 *  the whole PWA at boot. Feature-detect instead: an unsupported engine must lose grapheme
 *  precision, never the app. The `null` branches below fall back to per-code-point counting, which
 *  is exactly what this check did before clusters were understood at all — a match that stops mid
 *  cluster slips through there, as it always did. */
const GRAPHEMES =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** A cluster nobody can see: whitespace, or formatting controls that render as nothing at all
 *  (LRM/RLM, zero-width space, soft hyphen). A cluster that merely CONTAINS one still counts — the
 *  ZWJ inside a family emoji is joining visible characters, not standing in for them. */
const UNREADABLE = /^[\s\p{Default_Ignorable_Code_Point}]+$/u;

/** Visible characters. The floor below is a claim about how much of the message is legible on
 *  screen, so it must count what a reader counts — one emoji is one character, not the 11 UTF-16
 *  code units a ZWJ family sequence happens to occupy, and an invisible control is not a character
 *  at all however many of them are threaded through the text.
 *
 *  Segmenting the string AS GIVEN matters: stripping its spaces first can fuse the neighbours into
 *  one cluster. "🇯 🇵" is two characters, but strip the space and the regional indicators pair into
 *  the single flag "🇯🇵" — one character, and a floor half as high as it should be. */
function visibleLength(s: string): number {
  let n = 0;
  if (GRAPHEMES === null) {
    // Code points, not code units — a lone surrogate half is never a character on any engine.
    for (const ch of s) if (!UNREADABLE.test(ch)) n += 1;
    return n;
  }
  for (const segment of GRAPHEMES.segment(s)) if (!UNREADABLE.test(segment.segment)) n += 1;
  return n;
}

/** Every offset in `s` where one visible character ends and the next begins, plus both ends. A match
 *  that starts or stops anywhere else has sliced a character in half — "👩‍👧‍👦" is a code-unit
 *  substring of "👨‍👩‍👧‍👦", but it is a DIFFERENT character and must not verify as that one. */
function characterBoundaries(s: string): Set<number> {
  const bounds = new Set<number>([s.length]);
  if (GRAPHEMES === null) {
    let i = 0;
    for (const ch of s) {
      bounds.add(i);
      i += ch.length;
    }
    return bounds;
  }
  for (const segment of GRAPHEMES.segment(s)) bounds.add(segment.index);
  return bounds;
}

/**
 * Whether the input box's visible draft is evidence that `sent` landed there. The box WINDOWS a long
 * draft (only its tail is on screen) and FOLDS its wrapped lines together with a space, so exact
 * equality is too strict — the strongest claim that survives both is that the draft's visible
 * characters appear contiguously in what we typed.
 *
 * The fold is the subtle part. extractInputDraft joins the box's visual lines with a space, which
 * restores a REAL space only when the box happened to wrap at a word boundary; wrapping mid-run (CJK
 * has no spaces to break at) fabricates a space the sent text never had. The joined string cannot
 * say which kind each of its spaces is, and one string can hold both — "これは pull request です"
 * wrapped mid-CJK has a genuine space AND a fabricated one. So the ambiguity is per-SEAM, not
 * per-string, and no language test can resolve it.
 *
 * Hence: split the draft on whitespace and require its non-space runs to appear in `sent` in order,
 * with only whitespace between them. Every visible character still has to be there, contiguously and
 * in order — only the WIDTH of a gap the fold could have produced is treated as unknowable, which is
 * exactly what the fold destroyed. A draft that dropped or altered a non-space character still fails.
 *
 * Only a gap spelled exactly like the fold's own seam (one plain space) may collapse to nothing, and
 * only that gap is loosened at all. Any other gap — a run of spaces, a tab, an ideographic space —
 * is whitespace the terminal actually rendered, so `sent` must carry that same whitespace verbatim.
 * Without the distinction the guard would accept a screen holding "危険　実行" for a send of
 * "危険実行", or "delete　file" for "delete file": different messages, both authorised.
 *
 * The match must also land on visible-character boundaries, because a code-unit substring can cut a
 * character in half — "👩‍👧‍👦" sits inside "👨‍👩‍👧‍👦" without being it.
 *
 * The length floor stops a short unrelated remnant ("y", "n", a placeholder) from passing as a
 * match; for a send shorter than the floor, the whole thing must be there. It counts non-space
 * characters, since spaces are the part we just agreed not to trust.
 * The `Math.min` is not a nicety: the composer's one-tap Yes / No (#203) sends three- and two-
 * character words, so without it every such send would poll out and stall. With it the floor is the
 * whole word — the box must show `yes`, not a leftover `y`.
 */
export function draftCarriesSend(sent: string, draft: string | null): boolean {
  if (draft === null) return false;
  // Odd indices are the gaps, even indices the runs — the gaps decide how strict each seam is.
  const parts = draft.trim().split(/(\s+)/);
  const runs = parts.filter((_part, i) => i % 2 === 0);
  const gaps = parts.filter((_part, i) => i % 2 === 1);
  if (runs.length === 0 || runs[0]!.length === 0) return false;

  const visible = runs.reduce((n, run) => n + visibleLength(run), 0);
  if (visible < Math.min(visibleLength(sent), MIN_MATCH_CHARS)) return false;

  // Runs are whitespace-free by construction, so the joined pattern can never nest quantifiers.
  const escape = (s: string) => s.replace(REGEXP_META, "\\$&");
  let pattern = escape(runs[0]!);
  for (let i = 1; i < runs.length; i++) {
    const gap = gaps[i - 1]!;
    pattern += (gap === FOLD_SEAM ? "\\s*" : escape(gap)) + escape(runs[i]!);
  }

  // Every occurrence gets its own boundary check, not just the first: an earlier hit that happens to
  // stop mid-character must not mask a later, properly aligned one. Rewinding to one past the hit's
  // start (rather than to its end) keeps overlapping occurrences reachable.
  const scan = new RegExp(pattern, "g");
  const bounds = characterBoundaries(sent);
  for (let hit = scan.exec(sent); hit !== null; hit = scan.exec(sent)) {
    if (bounds.has(hit.index) && bounds.has(hit.index + hit[0].length)) return true;
    scan.lastIndex = hit.index + 1;
  }
  return false;
}

interface GuardedReplyArgs {
  paneId: string;
  text: string;
  /** The pane's agent — picks the adapter whose `extractInputDraft` can read the input box. */
  agent: string | undefined | null;
  /** Lines to request per verification read (undefined = the bridge's default tail, which is where
   *  the input box always is). */
  requestedLines?: number;
  /** Test seam for the poll pacing. */
  sleep?: Sleep;
  /**
   * Override the PRE-FLIGHT'S REFUSAL and type anyway — the user's deliberate second tap after a
   * `blocked` outcome (a mis-detected screen, an adapter that can't see a box it really has). The
   * live read still happens; `force` only stops a definite `false` from refusing the send. The
   * type-then-verify guard below still runs, so the submit key is never fired blind either way, and
   * `onComposerSeen` still does not run — a screen that just answered "no composer" is the last
   * place destructive keys may go.
   */
  force?: boolean;
  /**
   * Work the caller needs done once a live read has POSITIVELY SEEN the composer, and before the
   * first byte of the reply is typed. Exists for exactly one caller and one reason: composer.tsx's
   * pre-clear sweep (`ctrl+k` + a run of Backspaces that wipes a stranded draft off the input line so
   * `pane.send_text` doesn't append to it) is DESTRUCTIVE, and it used to run in the composer before
   * `sendGuardedReply` was called at all — i.e. before anything had looked at the live pane.
   *
   * That ordering is the whole bug. The composer decides to sweep from `display`, which is a
   * SNAPSHOT: a poll behind while the mirror follows the tail, and frozen outright while the user has
   * scrolled back or opened find. So its own fail-fast (`dialogPresent`) can read false against a pane
   * that has since put a dialog up, and the sweep then fires into that dialog — the exact
   * keystrokes-into-a-modal failure collie#34 is about, just upstream of where collie#34 was fixed.
   *
   * For an adapter that lifts NO interactive kind that fail-fast is not merely stale, it is inert:
   * `dialogPresent` is `buildBlocks(...).some(b => b.kind !== "raw")`, so an adapter whose
   * `buildBlocks` returns one `raw` block by construction can never make it true. Verified live
   * against a pane with a full-screen picker up: `dialogPresent === false`. There is no window
   * to widen or narrow there — `composerReady` is the ONLY gate on such a pane, which is why this
   * hook keys on it rather than on the caller having already checked something.
   *
   * The name is the contract: this runs ONLY on the branch where `composerReady` answered true about
   * a pane read moments ago. `force`, a read that threw, an adapter with no `composerReady`, no
   * adapter at all — none of them reaches it, and neither will whatever path is added next, because
   * `preflight` hands the runner back only on that one branch (see `Preflight`). Every other path
   * types without sweeping and leans on type-then-verify, which still withholds the submit key.
   *
   * Resolving `{ ok: false }` aborts the send with that error and nothing typed. `keysSent` says
   * whether anything actually reached the pane: when it did, the pre-flight's evidence is stale and
   * the guard re-confirms before typing.
   *
   * The argument carries the evidence FORWARD, not just the permission. `promptRegion` is the prompt
   * row the adapter saw on the pane the pre-flight just read, and a caller that sends destructive
   * keys must pass it to `api.sendKeys` as `expected_prompt`: an ordering guarantee alone cannot
   * bound the gap between the read and the keys, because that gap is a network round-trip and the
   * only limit on it is GET_TIMEOUT_MS. Binding hands the last word to the bridge, which re-reads
   * immediately before `send_keys` and 409s the write if the row has gone — the same mitigation
   * every dialog tap already gets through lib/dialog-guard.ts.
   */
  onComposerSeen?: (seen: ComposerSeen) => Promise<ComposerPrepResult>;
}

/** What the pre-flight's live read saw, handed to the caller's pre-type work. */
interface ComposerSeen {
  /**
   * The composer's own prompt row, verbatim on screen, for binding a destructive write to it
   * (`api.sendKeys(..., expectedPrompt)`). `null` when the adapter has no `composerPrompt` — then the
   * write goes out unbound, which is the pre-existing behaviour and the reason the hook is optional.
   */
  promptRegion: string | null;
}

type ComposerPrepResult =
  /** Done. `keysSent` = did anything actually go out on the wire? A caller with nothing to do says
   *  `false` and saves the guard a re-confirming read. */
  | { ok: true; keysSent: boolean }
  /** Abort the send with this error, nothing typed. */
  | { ok: false; error: string };

export async function sendGuardedReply(args: GuardedReplyArgs): Promise<ReplyOutcome> {
  const adapter = adapterFor(args.agent ?? undefined);
  // No grammar for this harness (or an adapter that cannot read its composer, replyOneShot) → the
  // input box is unreadable, so there is nothing to verify against and the guard cannot run. Keep the
  // legacy one-shot send rather than guess: a heuristic over the raw mirror has a false-negative that is
  // worse than the bug — a no-echo input (a shell's sudo prompt) would never show the text, so the
  // submit key would be withheld forever. Non-Claude harnesses gain this safety exactly when they gain an adapter.
  if (!adapter || adapter.replyOneShot) return oneShot(args);

  // PRE-FLIGHT. The verify-after guard below is enough to keep Enter from answering a dialog, but it
  // is not enough to keep the MESSAGE out of one: it types first and checks second, so a modal that
  // owns the keyboard (Claude's `/model` picker — no input box at the tail at all) receives the
  // user's text before anything notices. One read up front is the difference between "nothing
  // happened" and "your reply is now sitting in a picker".
  const { refuse, runPreType } = await preflight(adapter, args);
  if (refuse !== null) return refuse;

  // The ONE call site of the caller's destructive pre-type work — and it is not guarded by a
  // condition, it is guarded by whether the runner exists at all. `preflight` returns one only from
  // the branch where a live read just saw the composer, so every other path (force, a read that
  // threw, an adapter with no `composerReady`, and anything added later) skips this by construction
  // rather than by remembering to check. `?.()` is the whole enforcement; there is no list to keep
  // in sync.
  const aborted = await runPreType?.();
  if (aborted) return aborted;

  let typed;
  try {
    typed = await sendReply(args.paneId, args.text, false);
  } catch (e) {
    return { status: "error", error: message(e) };
  }
  if (!typed.ok) return { status: "error", error: typed.error };

  const sleep = args.sleep ?? defaultSleep;
  // The last screen a verification read actually saw, kept only so the stall below can be named. The
  // pre-flight catches almost every password prompt before a byte is typed, but not all of them: a
  // harness with no `composerReady`, and a `force` the operator armed against a mis-detected screen,
  // both arrive here having typed the secret into a prompt that will never echo it.
  let lastSeen: string | null = null;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    // Read BEFORE the first sleep: pane.read is an on-demand live read, not a cached poll, so the
    // text is often already on screen by the time the type call returns. That saves a whole
    // POLL_DELAY_MS off the common path — the old blind flow always paid a fixed 350ms here.
    if (attempt > 0) await sleep(POLL_DELAY_MS);
    let draft: string | null = null;
    try {
      const fresh = await fetchPane(args.paneId, args.requestedLines);
      const lines = parseLines(fresh.text);
      // Only a screen the adapter does NOT recognise as its composer can be a raw password prompt.
      // Without that gate a match on the tail is dangerous rather than merely wrong: the notice this
      // feeds tells the operator to press Enter in Type, so a stall that was really a dialog eating
      // the text — with an agent that happened to PRINT "Enter passphrase:" as its last line — would
      // have us advising the exact keystroke collie#34 exists to prevent. An adapter with no
      // `composerReady` cannot rule anything out, so it doesn't (`?? false`): that path is the
      // unguarded one either way, and it is where a bare shell's sudo prompt actually lives.
      const composerVisible = adapter.composerReady?.(lines) ?? false;
      lastSeen = composerVisible ? null : detectNoEchoPrompt(lines);
      draft = adapter.extractInputDraft(lines);
    } catch {
      continue; // transient read failure — the bounded loop is the timeout
    }
    if (draftCarriesSend(args.text, draft)) return submitOnly(args, adapter.submitKeys);
    // The adapter gets a second look, and only a second look: a harness can SWALLOW what we typed and
    // paint a token of its own instead (Claude collapses anything past its paste threshold into
    // `[Pasted text #N +M lines]`), so the box never holds our words and the match above structurally
    // cannot succeed — the send stalls forever while every retry re-collapses. The adapter is the only
    // thing that knows its harness's token and whether this one is consistent with THIS send
    // (.adr/0010). It can only widen the evidence, never narrow it, so a harness without the
    // capability is untouched.
    if (draft !== null && adapter.draftCarriesSend?.(args.text, draft)) return submitOnly(args, adapter.submitKeys);
  }

  // The text never showed up on the input line. The likeliest cause is a dialog holding focus and
  // eating the keystrokes — and the one thing we must NOT do is send the submit key anyway, because
  // that is precisely what answers the dialog. Stop dead and let the caller keep the draft.
  //
  // If instead this is a false negative (the text IS in the box, the adapter just couldn't see it),
  // nothing is lost: the next send's pre-clear sweep removes it, and the stranded-draft preview
  // surfaces it in the meantime.
  if (lastSeen !== null) {
    // Typed into a prompt that will never show it. The text IS in the pane — unsubmitted, which for a
    // password means the operator needs one Enter, not a retry, and a retry would type a second copy.
    return {
      status: "stalled",
      error:
        "That's a password prompt — it shows nothing as you type, so the text can't be confirmed and nothing was submitted. What you typed is already in the pane.",
      noEcho: lastSeen,
    };
  }
  return {
    status: "stalled",
    error:
      "Message didn't reach the input box — a dialog may be waiting, and if you were answering it by key that key likely landed. Nothing was submitted.",
  };
}

const NO_BOX =
  "The agent's input box isn't on screen — a menu or dialog is probably up. Nothing was typed.";

/** Said instead of {@link NO_BOX} when the screen is a password prompt. It names the mechanism rather
 *  than the symptom, because the operator's next move depends on knowing that waiting won't help. */
const NO_ECHO =
  "That's a password prompt — it shows nothing as you type, so Send can never confirm the text arrived. Nothing was typed.";

/**
 * What the pre-flight decided. Two fields, and the second is the safety invariant of this module made
 * structural rather than conditional:
 *
 *   `refuse`     — non-null ⇒ return it; the send is refused with no reply text typed.
 *   `runPreType` — non-null ⇒ a live read POSITIVELY SAW the composer, so the caller's destructive
 *                  pre-type work may run. It is created on exactly one branch below and nowhere else.
 *
 * The point of shipping the permission as a CALLABLE rather than a boolean is that there is nothing
 * for a later edit to re-derive, forget, or get subtly wrong: a new path through `preflight` that does
 * not positively confirm a composer cannot produce a runner, so it cannot fire a keystroke, whatever
 * its author intended. That is what the three holes the previous shape left open all had in common —
 * `force`, a read that threw, and an adapter with no `composerReady` each SKIPPED the read and then
 * ran the sweep anyway, because the sweep was gated on its own separate condition — "did the caller
 * hand me a callback?" — instead of on the evidence.
 */
interface Preflight {
  refuse: ReplyOutcome | null;
  runPreType: (() => Promise<ReplyOutcome | null>) | null;
}

/**
 * One live read, and everything the rest of the send is allowed to do with it.
 *
 * Fail-OPEN for the MESSAGE in both weak directions — an adapter without `composerReady` and a read
 * that throws both fall through to the type-then-verify guard rather than blocking a send on a
 * transient network blip — and fail-CLOSED for KEYS in every direction but one. Failing open for the
 * message is defensible: the submit key is still withheld until the text is seen. Extending that to a
 * `ctrl+k` + 40×Backspace burst is not, because those keys are not withheld by anything downstream —
 * once sent they have already landed in whatever owns the keyboard.
 */
async function preflight(adapter: HarnessAdapter, args: GuardedReplyArgs): Promise<Preflight> {
  const blind = (refuse: ReplyOutcome | null): Preflight => ({ refuse, runPreType: null });

  // Nothing here can read this harness's input box, so there is no evidence to be had — and no
  // refusal to make either. Same behaviour as before an adapter grows a `composerReady`, minus the
  // sweep, which had no business going out unverified.
  if (!adapter.composerReady) return blind(null);

  const composerReady = adapter.composerReady.bind(adapter);
  let probe;
  try {
    probe = await fetchPane(args.paneId, args.requestedLines);
  } catch {
    return blind(null); // transient read failure
  }
  const seen = parseLines(probe.text);
  if (!composerReady(seen)) {
    // `force` is the user's deliberate "type anyway", so it overrides the refusal — but this is the
    // one screen we have POSITIVE evidence about, and what it says is "no composer". Keys stay home.
    if (args.force) return blind(null);
    // The refusal is already made; naming the screen only changes what the operator is told. A
    // password prompt is the one case where the generic "a menu or dialog is probably up" is not just
    // unhelpful but actively misleading — there is no dialog to answer and no amount of retrying will
    // ever work, because the evidence this guard needs is exactly what the prompt is refusing to show
    // (collie#103). Hand the prompt itself back so the caller can say so and offer "Type".
    const noEcho = detectNoEchoPrompt(seen);
    if (noEcho !== null) return blind({ status: "blocked", error: NO_ECHO, noEcho });
    return blind({ status: "blocked", error: NO_BOX });
  }

  // The region the read's `true` was true OF. Computed here, from the same parse `composerReady` just
  // answered about, so the caller cannot bind its keys to anything but the screen that authorised
  // them — and cannot forget to, since it arrives as the argument.
  const promptRegion = adapter.composerPrompt?.(seen) ?? null;

  return {
    refuse: null,
    runPreType: async () => {
      if (!args.onComposerSeen) return null;
      let prep;
      try {
        prep = await args.onComposerSeen({ promptRegion });
      } catch (e) {
        return { status: "error", error: message(e) };
      }
      if (!prep.ok) return { status: "error", error: prep.error };
      if (!prep.keysSent) return null; // the read above is still the freshest thing there is

      // The caller put keys on the wire and waited for the TUI to settle, so the evidence that
      // authorised them is now an RPC and a settle old. Re-confirm before the MESSAGE goes out —
      // otherwise this ordering, which exists to stop keys reaching a dialog, would hand the dialog
      // the reply instead. Still fail-open on a throw: the submit key is guarded downstream.
      try {
        const fresh = await fetchPane(args.paneId, args.requestedLines);
        if (composerReady(parseLines(fresh.text))) return null;
      } catch {
        return null;
      }
      return {
        status: "blocked",
        error:
          "The agent's input box left the screen while its input line was being cleared — a menu or dialog is probably up. Your message wasn't typed.",
      };
    },
  };
}

/** The pre-collie#34 behaviour: one call that types AND submits. Only for harnesses with no adapter. */
async function oneShot(args: GuardedReplyArgs): Promise<ReplyOutcome> {
  // No `onComposerSeen` here, and none is possible: with no adapter nothing can read the input box,
  // so no live read can ever confirm a composer, and the invariant says the destructive sweep stays
  // home. It costs this path nothing — agent-chat derives the stranded draft through
  // `adapterFor(agent)?.extractInputDraft`, so a pane with no adapter has no draft to sweep and the
  // composer's callback was already a no-op here.
  try {
    const res = await sendReply(args.paneId, args.text, true);
    return res.ok ? { status: "sent" } : { status: "error", error: res.error };
  } catch (e) {
    return { status: "error", error: message(e) };
  }
}

/**
 * Empty text + submit: `sendReplySteps` skips the send_text step entirely and sends ONLY the
 * adapter's submit keys, with the bridge's configured keys as fallback. The no-adapter oneShot path
 * deliberately sends no submit_keys because it has no adapter to declare them.
 */
async function submitOnly(args: GuardedReplyArgs, submitKeys?: string[]): Promise<ReplyOutcome> {
  try {
    const res = await sendReply(args.paneId, "", true, undefined, submitKeys);
    if (res.ok) return { status: "sent" };
    // The text is verifiably sitting in the input box and only the submit key failed — same shape as
    // the bridge's own partial-failure case. Tell the caller not to resend.
    return {
      status: "error",
      error: "typed into the pane but not submitted — check the pane before resending",
      textDelivered: true,
    };
  } catch (e) {
    return { status: "error", error: message(e), textDelivered: true };
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
