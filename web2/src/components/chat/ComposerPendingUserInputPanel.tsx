// Adapted from T3 Code apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: one question per request. A Sightr `question` runtime request is one step of the dialog on
// screen, mapped to T3's question shape by shared/v2/request-question.ts and driven by T3's own
// pendingUserInput logic. Kept from T3: the card is keyed by request, so a new screen starts a fresh
// draft; a single-choice tap shows its check at once and answers 200 ms later; a multi-select tap
// toggles a local draft (seeded from the terminal's boxes) until the advance button sends the whole set;
// digits 1–9 pick or toggle, never while typing in a field. Sightr's additions (T17): the wizard stepper
// chips, the review step's echoed answers, a preview select's pane under the pointed option, the
// dialog's own advance label (`Submit` / `Next`) on the button, and T12's destructive rule ("Chat about
// this", a review's Cancel): warn colours, never first, a second tap to confirm. The Next/Submit
// control lives in the card rather than in the composer's primary actions, because the card replaces
// the composer. No collapse toggle and no dismiss: the card is the page's one "you" step. A question
// with no options (a free-text row) shows the prompt and Open terminal. A `freeText` question (the
// dialog's "Type something." row, T3's `allowCustomAnswer`) adds "Type your own answer": the bridge
// types the words into that row and presses Enter. 16px text and 44px targets; on a touch screen
// Enter is a newline (dictation, the soft return key), so only Send sends.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type Ref } from "react";
import { CheckIcon, Loader2Icon, MessageCircleQuestionIcon, SendHorizontalIcon, TriangleAlertIcon } from "lucide-react";

import type { RuntimeRequest } from "@shared/v2/contracts";
import {
  FREE_TEXT_MAX_CHARS,
  requestBoxCount,
  requestOptionIndex,
  requestOptionValue,
  requestQuestion,
} from "@shared/v2/request-question";
import { RESPONDING_ADVANCE, RESPONDING_TEXT, respondToRequest, respondWithText } from "@/state/composer";
import { cn } from "~/lib/utils";
import {
  derivePendingUserInputProgress,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "~/pendingUserInput";
import { ComposerBanner } from "./ComposerBanner";
import { OpenTerminalButton } from "./ComposerPendingApprovalPanel";
import { CONFIRM_MS } from "./ComposerPendingApprovalActions";
import { ComposerPendingUserInputStepper } from "./ComposerPendingUserInputStepper";

/** T3's delay between a single-choice tap (the check shows at once) and the answer going out. */
export const AUTO_ADVANCE_MS = 200;

interface PendingUserInputPanelProps {
  request: RuntimeRequest;
  pendingCount: number;
  /** The option whose answer is in flight; `RESPONDING_ADVANCE` for a checkbox step's set. */
  respondingIndex: number | null;
  verdict: string | null;
  disabled?: boolean;
  firstOptionRef?: Ref<HTMLButtonElement>;
  onRespond: (optionIndex: number) => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel(props: PendingUserInputPanelProps) {
  // T3 keys the card by request: a new screen (a toggle at the desk, the next wizard step) is a new
  // request, and its draft starts over from what the terminal shows.
  return <ComposerPendingUserInputCard key={props.request.id} {...props} />;
});

/** The draft a checkbox step starts from: the boxes the terminal shows ticked. */
export function initialDraft(request: RuntimeRequest): PendingUserInputDraftAnswer | undefined {
  const checked = request.multiSelect?.checked ?? [];
  const values = checked.flatMap((on, i) => (on ? [requestOptionValue(i)] : []));
  return values.length > 0 ? { selectedOptionValues: values } : undefined;
}

/** The option indices a draft selects, ascending. */
export function selectedIndices(values: readonly string[]): number[] {
  return values
    .map(requestOptionIndex)
    .filter((i): i is number => i !== null)
    .sort((a, b) => a - b);
}

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  request,
  pendingCount,
  respondingIndex,
  verdict,
  disabled = false,
  firstOptionRef,
  onRespond,
}: PendingUserInputPanelProps) {
  const question = useMemo(() => requestQuestion(request), [request]);
  const boxes = requestBoxCount(request);
  const multi = boxes > 0;
  const responding = respondingIndex !== null;
  const locked = disabled || responding;
  const review = request.answers !== undefined;
  const freeText = request.freeText === true && !review;

  const [draft, setDraft] = useState<PendingUserInputDraftAnswer | undefined>(() => initialDraft(request));
  const [optimistic, setOptimistic] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const progress = derivePendingUserInputProgress([question], { [question.id]: draft ?? {} }, 0);
  const selected = new Set(progress.selectedOptionValues);

  const timer = useRef<number | null>(null);
  const onRespondRef = useRef(onRespond);
  useEffect(() => {
    onRespondRef.current = onRespond;
  }, [onRespond]);
  // A delayed answer only goes out while the card can still answer.
  useEffect(() => {
    const clear = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
    if (disabled) clear();
    return clear;
  }, [disabled]);
  useEffect(() => {
    if (armed === null) return;
    const id = setTimeout(() => setArmed(null), CONFIRM_MS);
    return () => clearTimeout(id);
  }, [armed]);

  const pick = useCallback(
    (index: number) => {
      if (locked || timer.current !== null) return;
      const option = request.options[index];
      if (!option) return;
      if (multi && index < boxes) {
        setDraft((d) => togglePendingUserInputOptionSelection(question, d, requestOptionValue(index)));
        return;
      }
      if (option.destructive) {
        if (armed !== index) {
          setArmed(index);
          return;
        }
        setArmed(null);
        onRespond(index);
        return;
      }
      setArmed(null);
      setOptimistic(index);
      if (!multi) setDraft((d) => togglePendingUserInputOptionSelection(question, d, requestOptionValue(index)));
      timer.current = window.setTimeout(() => {
        timer.current = null;
        onRespondRef.current(index);
      }, AUTO_ADVANCE_MS);
    },
    [armed, boxes, locked, multi, onRespond, question, request.options],
  );

  const advance = useCallback(() => {
    if (locked || !progress.canAdvance) return;
    void respondToRequest(request.threadId, request.id, selectedIndices(progress.selectedOptionValues));
  }, [locked, progress.canAdvance, progress.selectedOptionValues, request.id, request.threadId]);

  // T3: digits 1–9 pick (or toggle) an option when focus is not in a text field. Destructive options
  // are skipped: they need the second tap on the button itself.
  const options = request.options;
  const digitTargets = multi ? options.slice(0, boxes) : options;
  useEffect(() => {
    if (locked || digitTargets.length === 0) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLElement && target.closest('[contenteditable]:not([contenteditable="false"])')) return;
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const option = digitTargets[digit - 1];
      if (!option || option.destructive) return;
      event.preventDefault();
      pick(digit - 1);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [digitTargets, locked, pick]);

  // The boxes (or every option) first, destructive rows last (T12: never first).
  const order = options.map((option, index) => ({ option, index }));
  const rows = [...order.filter((o) => !o.option.destructive), ...order.filter((o) => o.option.destructive)];
  const firstPlain = rows.find((r) => !r.option.destructive)?.index;

  return (
    <ComposerBanner.Root variant="you" density="spacious" data-request-kind="question" data-question-id={question.id}>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-xs">
          <MessageCircleQuestionIcon className="size-4 text-house-accent" aria-hidden="true" />
          <h2 className="font-semibold text-house-accent">The agent is asking</h2>
          {question.header !== "Question" ? <span className="truncate text-muted-foreground">{question.header}</span> : null}
          {pendingCount > 1 ? <span className="ml-auto tabular-nums text-muted-foreground">1/{pendingCount}</span> : null}
        </div>
        {request.steps && request.steps.length > 0 ? <ComposerPendingUserInputStepper steps={request.steps} review={review} /> : null}
        <p className="max-h-40 overflow-auto whitespace-pre-wrap text-sm text-foreground" tabIndex={0} aria-label="Question">
          {request.prompt}
        </p>
        {request.answers && request.answers.length > 0 ? (
          <dl className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm" aria-label="Your answers">
            {request.answers.map((a, i) => (
              <div key={i} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{a.question}</dt>
                <dd className="break-words font-medium text-foreground">{a.answer}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {multi ? <p className="text-xs text-muted-foreground">Select one or more options.</p> : null}
        {options.length > 0 ? (
          <div className="flex flex-col gap-1.5" data-request-options="true">
            {rows.map(({ option, index }) => {
              const box = multi && index < boxes;
              const destructive = option.destructive === true;
              const isArmed = armed === index;
              const isSelected = box ? selected.has(requestOptionValue(index)) : optimistic === index || (!multi && selected.has(requestOptionValue(index)));
              const busy = respondingIndex === index;
              const shortcut = !destructive && (box || !multi) && index < 9 ? index + 1 : null;
              const previewLines = request.preview && request.preview.optionIndex === index ? request.preview.lines : null;
              return (
                <div key={index} className="flex flex-col gap-1">
                  <button
                    ref={index === firstPlain ? firstOptionRef : undefined}
                    type="button"
                    role={box ? "checkbox" : undefined}
                    aria-checked={box ? isSelected : undefined}
                    data-option-index={index}
                    data-selected={isSelected || undefined}
                    aria-busy={busy || undefined}
                    disabled={locked}
                    onClick={() => pick(index)}
                    className={cn(
                      "group flex min-h-11 w-full items-center gap-2 rounded-lg border-2 px-3 py-2 text-left text-sm outline-none transition-colors pointer-fine:sm:min-h-9",
                      "focus-visible:ring-2 focus-visible:ring-you/40 disabled:cursor-not-allowed",
                      destructive
                        ? "border-warn/50 bg-warning-surface text-warn hover:border-warn"
                        : isSelected
                          ? "border-you bg-you-soft text-foreground"
                          : "border-border bg-card text-foreground hover:border-you",
                      busy && "border-you bg-you-soft",
                      locked && !busy && "opacity-60",
                      isArmed && "border-warn bg-warn text-paper",
                    )}
                  >
                    {box ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded border",
                          isSelected ? "border-you bg-you text-you-foreground" : "border-muted-foreground",
                        )}
                      >
                        {isSelected ? <CheckIcon className="size-3" /> : null}
                      </span>
                    ) : null}
                    {destructive ? <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" /> : null}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="break-words font-medium">{isArmed ? "Tap again to confirm" : option.label}</span>
                      {option.description && option.description !== option.label && !isArmed ? (
                        <span className="text-xs font-normal text-muted-foreground">{option.description}</span>
                      ) : null}
                    </span>
                    {busy ? (
                      <Loader2Icon className="size-4 shrink-0 animate-spin" aria-label="Sending" />
                    ) : !box && isSelected ? (
                      <CheckIcon className="size-3.5 shrink-0 text-you" aria-hidden="true" />
                    ) : shortcut !== null ? (
                      <kbd
                        aria-hidden="true"
                        className="flex size-5 shrink-0 items-center justify-center text-[10px] font-medium text-muted-foreground tabular-nums"
                      >
                        {shortcut}
                      </kbd>
                    ) : null}
                  </button>
                  {previewLines ? (
                    <pre
                      aria-label={`Preview of ${option.label}`}
                      className="max-h-60 overflow-auto rounded-lg border border-border bg-card px-2 py-1.5 font-[Consolas,ui-monospace,monospace] text-[11px] leading-tight text-foreground"
                    >
                      {previewLines.join("\n")}
                    </pre>
                  ) : null}
                </div>
              );
            })}
            {multi ? (
              <button
                type="button"
                data-advance="true"
                aria-busy={respondingIndex === RESPONDING_ADVANCE || undefined}
                disabled={locked || !progress.canAdvance}
                onClick={advance}
                className={cn(
                  "mt-1 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border-2 border-you bg-you px-3 py-2 text-sm font-semibold text-you-foreground transition-colors pointer-fine:sm:min-h-9",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {respondingIndex === RESPONDING_ADVANCE ? <Loader2Icon className="size-4 animate-spin" aria-label="Sending" /> : null}
                {request.multiSelect!.advanceLabel}
              </button>
            ) : null}
          </div>
        ) : freeText ? null : (
          <>
            <p className="text-sm text-muted-foreground">Answer in the Terminal tab.</p>
            <div>
              <OpenTerminalButton threadId={request.threadId} />
            </div>
          </>
        )}
        {freeText ? (
          <FreeTextAnswer request={request} locked={locked} sending={respondingIndex === RESPONDING_TEXT} />
        ) : null}
        {verdict ? (
          <p role="status" className="text-xs text-muted-foreground">
            {verdict}
          </p>
        ) : null}
      </div>
    </ComposerBanner.Root>
  );
});

/** A draft per thread, so a dialog that redraws (a new request, same question) keeps what was typed. */
const freeTextDrafts = new Map<string, string>();

/** A touch screen: Enter there is a newline (dictation, the soft return key), never a send. */
function coarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
}

function FreeTextAnswer({ request, locked, sending }: { request: RuntimeRequest; locked: boolean; sending: boolean }) {
  const id = useId();
  const [draft, setDraftState] = useState(() => freeTextDrafts.get(request.threadId) ?? "");
  const setDraft = (next: string) => {
    freeTextDrafts.set(request.threadId, next);
    setDraftState(next);
  };
  const empty = draft.trim() === "";
  const send = async () => {
    if (locked || empty) return;
    if (await respondWithText(request.threadId, request.id, draft.trim())) freeTextDrafts.delete(request.threadId);
  };
  return (
    <div className="flex flex-col gap-1.5" data-free-text="true">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        Type your own answer
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id={id}
          value={draft}
          rows={1}
          maxLength={FREE_TEXT_MAX_CHARS}
          disabled={locked}
          enterKeyHint="send"
          autoCapitalize="sentences"
          placeholder="Your answer"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || coarsePointer()) return;
            e.preventDefault();
            void send();
          }}
          className="field-sizing-content max-h-32 min-h-11 min-w-0 flex-1 resize-none rounded-lg border-2 border-border bg-card px-3 py-2 text-base text-foreground outline-none focus:border-you disabled:opacity-60"
        />
        <button
          type="button"
          data-free-text-send="true"
          aria-busy={sending || undefined}
          disabled={locked || empty}
          onClick={() => void send()}
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border-2 border-you bg-you px-3 text-sm font-semibold text-you-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        >
          {sending ? (
            <Loader2Icon className="size-4 animate-spin" aria-label="Sending" />
          ) : (
            <SendHorizontalIcon className="size-4" aria-hidden="true" />
          )}
          Send
        </button>
      </div>
    </div>
  );
}
