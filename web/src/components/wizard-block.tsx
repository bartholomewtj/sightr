import { useState } from "react";
import { AlertTriangle, Check, Loader2, MessageSquarePlus } from "lucide-react";

import { WizardStepper } from "@/components/wizard-stepper";
import type { WizardAnswer, WizardFeedback, WizardModel, WizardOption } from "@/lib/blocks";
import { FEEDBACK_MAX_LENGTH } from "@/lib/actions";
import { OptionButton, PromptPanel, QuestionHeading } from "@/components/option-button";
import {
  WIZARD_BACK_KEYS,
  WIZARD_CANCEL_KEYS,
  WIZARD_NEXT_KEYS,
  WIZARD_SUBMIT_KEYS,
} from "@/lib/harness/wizard-model";

export interface WizardBlockProps {
  /** The detected wizard step (question or Submit review) with its stepper state. */
  wizard: WizardModel;
  /**
   * Injected send handler (from AgentChat). Presentational contract: this component NEVER touches
   * the network — every control resolves to ONE keystroke (`keys`) that the handler race-guards
   * and sends (the incremental round-trip model; see harness/claude/wizard.ts). Returning/throwing
   * simply clears the busy state.
   */
  onAction: (keys: string[]) => void | Promise<void>;
  /**
   * Pi's free-text row. Absent on Claude wizards. Returning `false` keeps the draft on screen.
   * The handler walks the pointer, types, and submits — this component never sends keys itself.
   */
  onFeedback?: (text: string) => boolean | void | Promise<boolean | void>;
  /** Read-only device or a gone pane: everything renders (for context) but can't be pressed. */
  disabled?: boolean;
}

// Native, tappable rendering of Claude's multi-question AskUserQuestion wizard. Mirrors exactly
// what the TUI shows — the stepper chips, then the CURRENT step's body — because the terminal is
// the single source of truth for selections; Sighter holds no form state of its own. Every visible
// string (chip labels, question, options, answers) is a React text node — the XSS boundary is
// unchanged. One control can be in flight at a time (spinner shows, the rest lock).
export function WizardBlock({ wizard, onAction, onFeedback, disabled }: WizardBlockProps) {
  const [sending, setSending] = useState<string | null>(null);
  const locked = disabled || sending !== null;
  const feedback = wizard.phase === "question" ? wizard.feedback : undefined;
  // Left/Right change tabs until the editor is open. After that they belong to the box.
  const navLocked = locked || (feedback?.editing ?? false);

  async function press(id: string, keys: string[]) {
    if (locked) return;
    setSending(id);
    try {
      await onAction(keys);
    } finally {
      setSending(null);
    }
  }

  async function sendFeedback(text: string): Promise<boolean> {
    if (locked || !onFeedback || feedback?.editing) return false;
    setSending("feedback");
    try {
      return (await onFeedback(text)) !== false;
    } finally {
      setSending(null);
    }
  }

  const review = wizard.phase === "review";
  // The review step shows no stepper, so neither Left nor Right can be sent from it (#371).
  // On question steps, the TUI clamps navigation (no wraparound): Left at the first question is a
  // no-op, so disable that arrow rather than send a keystroke that does nothing.
  // When no chip reads as current (an unknown theme's highlight), both stay enabled — the TUI still
  // clamps, and keeping nav available is the safer degradation.
  const busyIcon = <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Sending" />;

  return (
    <PromptPanel ariaLabel={review ? "Review your answers" : wizard.question}>
      {/* Stepper: rendered only on question steps (#371: review step shows no stepper, so Left/Right
          cannot be sent from the confirm screen). Flanked by back/next navigation the TUI drives with
          ←/→ (each tap sends exactly that one key). */}
      {!review && (
        <WizardStepper
          steps={wizard.steps}
          locked={navLocked}
          busyBack={sending === "back"}
          busyNext={sending === "next"}
          busyIcon={busyIcon}
          onBack={() => press("back", WIZARD_BACK_KEYS)}
          onNext={() => press("next", WIZARD_NEXT_KEYS)}
        />
      )}

      {wizard.phase === "question" ? (
        <QuestionStep
          question={wizard.question}
          options={wizard.options}
          feedback={feedback}
          locked={locked}
          sendingId={sending}
          onPress={press}
          onFeedback={onFeedback ? sendFeedback : undefined}
        />
      ) : (
        <ReviewStep wizard={wizard} locked={locked} sendingId={sending} onPress={press} />
      )}
    </PromptPanel>
  );
}

function QuestionStep({
  question,
  options,
  feedback,
  locked,
  sendingId,
  onPress,
  onFeedback,
}: {
  question: string;
  options: WizardOption[];
  feedback?: WizardFeedback;
  locked: boolean;
  sendingId: string | null;
  onPress: (id: string, keys: string[]) => void;
  onFeedback?: (text: string) => boolean | void | Promise<boolean | void>;
}) {
  const answers = options.filter((o) => !o.escape);
  const escapes = options.filter((o) => o.escape);
  // Enter on the free-text row opens the editor, so option buttons stay dead while the pointer
  // is there or the box is open. The type-in control itself stays available until the box opens.
  const optionsLocked = locked || (feedback?.focused ?? false) || (feedback?.editing ?? false);
  return (
    <>
      <QuestionHeading>{question}</QuestionHeading>
      <div className="flex flex-col gap-1">
        {answers.map((option, i) => {
          const id = `opt-${i}`;
          const busy = sendingId === id;
          return (
            <OptionButton
              key={i}
              tone={busy ? "busy" : option.chosen ? "selected" : "default"}
              keyLabel={option.keyLabel ?? option.keys[0]}
              label={option.label}
              description={option.description}
              disabled={optionsLocked}
              onClick={() => onPress(id, option.keys)}
              trailing={
                busy ? (
                  <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Sending" />
                ) : option.chosen ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-label="Current answer" />
                ) : null
              }
            />
          );
        })}
      </div>
      {/* The escape row ("Chat about this") ends the WHOLE wizard — the tool call resolves as
          declined — so it renders apart and de-emphasised, never like an answer. */}
      {escapes.map((option, i) => {
        const id = `esc-${i}`;
        return (
          <button
            key={i}
            type="button"
            disabled={optionsLocked}
            onClick={() => onPress(id, option.keys)}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
          >
            <span className="min-w-0 flex-1">
              {option.label}
              <span className="text-muted-foreground"> — ends the questions</span>
            </span>
            {sendingId === id ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" aria-label="Sending" />
            ) : null}
          </button>
        );
      })}
      {feedback && onFeedback ? (
        <WizardTypeIn
          feedback={feedback}
          locked={locked || feedback.editing}
          sending={sendingId === "feedback"}
          onSend={onFeedback}
        />
      ) : null}
    </>
  );
}

function WizardTypeIn({
  feedback,
  locked,
  sending,
  onSend,
}: {
  feedback: WizardFeedback;
  locked: boolean;
  sending: boolean;
  onSend: (text: string) => boolean | void | Promise<boolean | void>;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const digits = feedback.keys.some((k) => /^\d+$/.test(k));
  const busyIcon = (
    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Sending" />
  );

  async function send() {
    const text = draft.trim();
    if (text.length === 0 || locked) return;
    if ((await onSend(text)) !== false) setEditorOpen(false);
  }

  if (sending) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {busyIcon}
        Sending answer…
      </div>
    );
  }
  if (feedback.editing) {
    return (
      <div className="rounded-lg border border-dashed border-status-working/50 px-3 py-2 text-xs text-status-working">
        The answer box has the keyboard in the terminal — these buttons would type into it instead of answering. They resume when it closes.
        {feedback.text ? <span className="text-muted-foreground"> ({feedback.text})</span> : null}
      </div>
    );
  }
  if (feedback.text !== "") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
        <MessageSquarePlus className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label="Answer in the terminal" />
        <span className="min-w-0 flex-1 text-xs text-foreground/90">
          A custom answer is being written in the terminal: {feedback.text}
        </span>
      </div>
    );
  }
  if (digits) return null;
  if (editorOpen) {
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
        <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <MessageSquarePlus className="size-3.5 shrink-0" />
          Your answer
        </label>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={FEEDBACK_MAX_LENGTH}
          rows={3}
          autoFocus
          aria-label="Feedback text"
          placeholder="Type a custom answer…"
          className="w-full resize-none rounded-md border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-you"
        />
        <p className="text-[11px] leading-snug text-muted-foreground">
          Sends this text as the question's custom answer.
        </p>
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            disabled={locked}
            onClick={() => setEditorOpen(false)}
            className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={locked || draft.trim().length === 0}
            onClick={() => void send()}
            className="flex items-center gap-1.5 rounded-md border-2 border-you bg-you-soft px-2.5 py-1.5 text-xs font-medium text-control-on-foreground transition-colors active:bg-you/20 disabled:opacity-60"
          >
            Send answer
          </button>
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={locked}
      onClick={() => {
        setDraft("");
        setEditorOpen(true);
      }}
      className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
    >
      <MessageSquarePlus className="size-3.5 shrink-0" />
      Type your answer
    </button>
  );
}

export function ReviewAnswerList({ answers }: { answers: WizardAnswer[] }) {
  if (answers.length === 0) return null;
  return (
    <dl className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
      {answers.map((qa, i) => (
        <div key={i}>
          <dt className="text-xs text-muted-foreground">{qa.question}</dt>
          <dd className="text-sm font-medium text-foreground">{qa.answer}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReviewStep({
  wizard,
  locked,
  sendingId,
  onPress,
}: {
  wizard: Extract<WizardModel, { phase: "review" }>;
  locked: boolean;
  sendingId: string | null;
  onPress: (id: string, keys: string[]) => void;
}) {
  return (
    <>
      <div className="text-sm font-medium text-foreground">Review your answers</div>
      <ReviewAnswerList answers={wizard.answers} />
      {wizard.incomplete && (
        <div className="flex items-center gap-1.5 text-xs text-status-working">
          <AlertTriangle className="size-3.5 shrink-0" />
          You have not answered all questions
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          disabled={locked || wizard.submitKeys === null}
          onClick={() => onPress("submit", wizard.submitKeys ?? WIZARD_SUBMIT_KEYS)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-you bg-you-soft px-3 py-2 text-sm font-medium text-control-on-foreground transition-colors active:bg-you/20 disabled:opacity-60"
        >
          {sendingId === "submit" ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Sending" />
          ) : null}
          Submit answers
        </button>
        <button
          type="button"
          disabled={locked}
          onClick={() => onPress("cancel", wizard.cancelKeys ?? WIZARD_CANCEL_KEYS)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border/70 px-3 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
        >
          {sendingId === "cancel" ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-label="Sending" />
          ) : null}
          Cancel
        </button>
      </div>
    </>
  );
}
