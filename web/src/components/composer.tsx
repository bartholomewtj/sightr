import { forwardRef, useImperativeHandle, useRef } from "react";
import { Check, Keyboard, Loader2, Send } from "lucide-react";

import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import { setStatus } from "@/lib/status";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { isDestructiveInput } from "@/lib/destructive";
import { fitsDraftStore } from "@/lib/drafts";
import { textToKeySequence } from "@/lib/key-queue";
import { normalizeDraft } from "@/hooks/use-terminal-draft";
import { useComposerState } from "@/hooks/use-composer-state";
import { planSendTap, runComposerSend } from "@/lib/composer-send";
import { ComposerDrawers, ComposerStrips } from "@/components/composer-drawers";
import { ComposerMenu } from "@/components/composer-menu";
import { YesNoStrip } from "@/components/yes-no-strip";
import { DirectTypingStrip } from "@/components/direct-typing-strip";
import { GestureWheel } from "@/components/gesture-wheel";
import type { PromptSelectBlock } from "@/lib/blocks";
import type { PromptBlockAction } from "@/components/prompt-select-block";

export interface ComposerHandle {
  /** Focus the input and put the caret at the end — used by the mirror-tap-to-focus in AgentChat. */
  focusInput: () => void;
  /** Arm direct typing from the desktop mirror. */
  armDirect: () => void;
  /** Release direct typing without a status announcement. */
  releaseDirect: () => void;
  /** Toggle direct typing from the desktop chord. */
  toggleDirect: () => void;
  /** Type a held uploaded-image path into the terminal. */
  typePath: (path: string) => void;
  /** Send a no-arg slash command (pane-details Context → `/context`). */
  sendSlash: (text: string) => void;
}

interface ComposerProps {
  paneId: string;
  /** The pane's agent name — drives the slash-command palette and the reply-vs-shell placeholder. */
  agent: string | undefined | null;
  /** True for a bare shell pane (tweaks the placeholder copy). */
  isShell: boolean;
  /** Pane is gone (no agent) — locks the composer with a distinct placeholder. */
  gone: boolean;
  /** This device isn't authorised to type — locks the composer with a distinct placeholder. */
  readOnly: boolean;
  /** A dialog (prompt/wizard/preview/multi-select) is on screen, so the TUI's keyboard belongs to it.
   * Free-text sending is refused while true — see send(). Answer it with its own buttons instead. */
  dialogPresent: boolean;
  /** The pane's agent is waiting on you (`agent.status === "blocked"`). Drives the one-tap Yes / No
   * strip when no dialog was parsed. Optional for callers that cannot know the pane status. */
  agentBlocked?: boolean;
  /** The current recognised prompt, used for desktop number-key picking. */
  promptBlock?: PromptSelectBlock;
  /** Runs a prompt option through the existing dialog guard. */
  onPromptAction?: (action: PromptBlockAction, prompt: PromptSelectBlock["prompt"]) => Promise<boolean>;
  /** Latest pane text. Threaded through to the state hook; nothing reads it since the "You sent:"
   * strip went (the pending bubble in the journal shows the send). */
  text: string;
  /** A user draft stranded on the terminal's "❯" input line (extractInputDraft), STABILISED across
   * polls (useStableTerminalDraft) — non-null only once the same text has held for ~1.5s. Gates the
   * APPEARANCE of the read-only draft preview, so a one-poll blip or an in-flight send never flashes it. */
  terminalDraft: string | null;
  /** The SAME draft, but the RAW per-poll value (pre-stabilisation). Once the preview is showing, its
   * text tracks this live so host typing streams into it; it also drives the send()-time pre-clear (the
   * actual current "❯" line) and unmounts the preview when it goes null. Never written into the input. */
  rawTerminalDraft: string | null;
  /** Mirror display prefs — the Display dock and the Terminal toggle live here, but the mirror (in
   * AgentChat) reads the same single instance, so they're threaded through rather than each calling
   * useDisplayPrefs. */
  prefs: DisplayPrefs;
  stepFontSize: (delta: number) => void;
  setRawTerminal: (raw: boolean) => void;
  setTapToFocus: (tapToFocus: boolean) => void;
  setShowTerminal: (showTerminal: boolean) => void;
  setShowThinking: (showThinking: boolean) => void;
  /** Snap the mirror to the live tail (follow + revalidate + scroll) after a successful send. */
  /** Called with the text that was sent, after a VERIFIED send. */
  onSent: (text: string) => void;
  /** Desktop mode reports the textarea-owned armed state to the mirror. */
  onArmedChange?: (armed: boolean) => void;
}

// The composer cluster at the bottom of the pane view — everything a phone keyboard can't do on its
// own: an agent-aware slash-command palette, an inline key tray (via
// `pane.send_keys`), image upload, display prefs, the Terminal toggle, and the reply Send (with a
// destructive-command two-tap guard). Its state (draft, sending, upload, its own Keys/Agent/Display
// drawers) is entirely local; it reaches AgentChat only through `onSent` (to re-follow the tail) and
// exposes `focusInput` so the mirror tap can bring up the keyboard.
//
// One rounded field, a + on its left, Send on its right. Everything else is a row in the + menu
// (composer-menu.tsx): the permanent control row it replaced cost a whole row of a phone viewport
// for things you reach for a few times a session. Keys and Display still open as in-flow docks
// above the field rather than covering sheets, because you need to see the mirror while you use
// them. Find lives in the header, where its find bar already takes over the row.
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { paneId, agent, isShell, gone, readOnly, dialogPresent, agentBlocked = false, promptBlock, onPromptAction, text, terminalDraft, rawTerminalDraft, prefs, stepFontSize, setRawTerminal, setTapToFocus, setShowTerminal, setShowThinking, onSent, onArmedChange },
  ref,
) {
  const {
    input,
    updateInput,
    sending,
    setSending,
    uploading,
    justSent,
    setJustSent,
    lastSentRef,
    sentTimer,
    setHandledKey,
    setPreviewLatched,
    drawer,
    requestDrawer,
    locked,
    lockedRef,
    effectiveRaw,
    showPreview,
    takeOverDraft,
    commands,
    operatorCommands,
    keyPresets,
    wheelSlices,
    focusInputImmediately,
    direct,
    directRef,
    toggleDirect,
    noEcho,
    noticeNoEcho,
    sendConfirm,
    forceConfirm,
    scheduleKeyRevalidate,
    pressKeys,
    fileRef,
    inputRef,
    pathHold,
    showDesktopStrip,
    showYesNo,
    stripReason,
    adapter,
    confirmingSend,
    forcingSend,
    setQueuedKeys,
    insertCommand,
    desktop,
    onPickImage,
    onPasteImage,
    onInputKeyDown,
    placeholder,
  } = useComposerState({
    paneId,
    agent,
    isShell,
    gone,
    readOnly,
    text,
    dialogPresent,
    agentBlocked,
    terminalDraft,
    rawTerminalDraft,
    promptBlock,
    onPromptAction,
    onArmedChange,
  });
  async function send(value: string, isDraft: boolean, force = false): Promise<boolean> {
    const t = value.trim();
    if (!t || locked || sending) return false;
    try {
      const r = await runComposerSend(t, {
        paneId,
        agent,
        dialogPresent,
        force,
        isDraft,
        confirmDialog: () => forceConfirm.confirm("dialog"),
        isLocked: () => lockedRef.current,
        terminalLine: effectiveRaw,
        onStart: () => setSending(true),
        onKeysSent: scheduleKeyRevalidate,
      });
      if (r.status) setStatus(r.status.text, r.status.tone);
      if (r.clearDraft) updateInput("");
      if (r.armForce) forceConfirm.confirm("force");
      if (r.resetForce) forceConfirm.reset();
      noticeNoEcho(r.noEcho);
      if (r.ok && r.sent) {
        lastSentRef.current = { text: r.sent, at: Date.now() };
        if (effectiveRaw !== null) {
          setHandledKey(normalizeDraft(effectiveRaw));
          setPreviewLatched(false);
        }
        setJustSent(true);
        if (sentTimer.current) clearTimeout(sentTimer.current);
        sentTimer.current = setTimeout(() => setJustSent(false), 1500);
        onSent(r.sent);
      }
      return r.ok;
    } finally {
      setSending(false);
    }
  }
  // Gate the composer's Send through the destructive-input confirm: a matching command arms the
  // "Really send?" state instead of sending; the confirming second tap goes through. Non-destructive
  // input sends immediately (and any stray armed state is cleared).
  function onSendClick() {
    // An armed override takes precedence: this tap IS the deliberate "type anyway", so it skips the
    // destructive re-confirm (already answered on the tap that got blocked) and the pre-flight.
    const forceArmed =
      forceConfirm.pending === "force" || forceConfirm.pending === "dialog";
    const destructiveReason = isDestructiveInput(input);
    const tap = planSendTap(input, {
      forceArmed,
      // `confirm` ARMS the two-tap state as a side effect, so ask it ONLY when there is something
      // destructive to confirm. A plain send must never arm "Really send?".
      destructiveConfirmed:
        forceArmed || !destructiveReason ? true : sendConfirm.confirm("send"),
      destructiveReason,
    });
    if (tap.kind === "arm-destructive") {
      setStatus(tap.status.text, tap.status.tone);
      return;
    }
    if (forceArmed) forceConfirm.reset();
    sendConfirm.reset();
    void send(input, true, tap.force);
  }
  function sendWord(word: string) {
    if (forceConfirm.pending === "force") {
      forceConfirm.reset();
      void send(word, false, true);
      return;
    }
    void send(word, false);
  }

  const sendRef = useRef(send);
  sendRef.current = send;

  useImperativeHandle(
    ref,
    () => ({
      focusInput: focusInputImmediately,
      armDirect: () => {
        if (!directRef.current.active) directRef.current.activate();
      },
      releaseDirect: () => {
        if (directRef.current.active) directRef.current.deactivateSilently();
      },
      toggleDirect,
      typePath: (path: string) => {
        focusInputImmediately();
        void pressKeys(textToKeySequence(path));
      },
      sendSlash: (text: string) => {
        void sendRef.current(text, false);
      },
    }),
    [],
  );

  // Resolves true only on a VERIFIED send (the text was seen in the pane's input box before the
  // submit key went out). The send control consumes the verdict to drive its own ✓ and to decide
  // whether to close its dock, so every early return below has to answer honestly.

  return (
    <>
      <div className="relative border-t border-border/60 bg-muted px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)] pt-2.5">
        <ComposerDrawers
          drawer={drawer}
          onDrawer={requestDrawer}
          locked={locked}
          keys={{
            presets: keyPresets,
            onSend: pressKeys,
            onQueueChange: setQueuedKeys,
          }}
          display={{
            prefs,
            stepFontSize,
            setRawTerminal,
            setTapToFocus,
            setShowTerminal,
            setShowThinking,
          }}
          type={{
            active: direct.active,
            disabled: locked || sending,
            onStart: () => direct.activate(),
          }}
          palette={{
            agent,
            mine: operatorCommands,
            onInsert: insertCommand,
            onSubmit: (t: string) => send(t, false),
          }}
        />
        {/* The bridge decides what it will take (bridge/uploads.ts `uploadExt`); `accept` only steers
            the picker. `text/*` alone hides .md and .json on some phone pickers, so the text half is
            spelled out — an extension the bridge refuses is refused with a message either way. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,text/*,.md,.markdown,.txt,.json,.jsonl,.yaml,.yml,.toml,.csv,.tsv,.log,.xml,.html,.htm,.css,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.go,.rs,.sh,.bash,.ps1,.sql,.diff,.patch"
          hidden
          onChange={onPickImage}
        />
        <ComposerStrips
          preview={
            showPreview && effectiveRaw !== null
              ? {
                  text: effectiveRaw,
                  onTakeOver: adapter?.draftIsOpaque?.(effectiveRaw) ? null : takeOverDraft,
                }
              : null
          }
          noEcho={
            noEcho !== null && !direct.active
              ? {
                  prompt: noEcho.prompt,
                  typed: noEcho.typed,
                  onUseType: locked
                    ? null
                    : () => {
                        updateInput("");
                        requestDrawer(null);
                        direct.activate();
                      },
                  onDismiss: () => noticeNoEcho(null),
                }
              : null
          }
          direct={{
            show: !desktop && direct.active,
            onStop: () => direct.deactivate(),
          }}
          tooLong={!direct.active && !fitsDraftStore(input)}
        />
        {showYesNo && <YesNoStrip onYes={() => sendWord("yes")} onNo={() => sendWord("no")} />}
        {/* gap-3, not gap-2: this row is only the field and Send, and the old spacing left them
            looking joined. */}
        <div className="flex items-end gap-3">
          {/* The input and the + share one box: the button is positioned INSIDE the field,
              messenger-style, rather than sitting beside it as a third control in the row. `pl-11`
              on the textarea reserves that strip so a long line can never run underneath it.
              The wheel handle is a child of this box so it sits on the field's top-right, not over Send. */}
          <div className="relative min-w-0 flex-1">
            {!desktop && !locked && (
              <GestureWheel
                slices={wheelSlices}
                onKeys={pressKeys}
                onType={() => {
                  if (direct.active) {
                    direct.deactivate();
                    return;
                  }
                  requestDrawer(null); // a dock holds half the viewport and this mode needs the keyboard
                  direct.activate();
                }}
                typeActive={direct.active}
                // Tap toggles the Keys dock. Closing with staged chords still runs through requestDrawer's discard confirm.
                onTap={() => requestDrawer(drawer === "keys" ? null : "keys")}
                disabled={sending}
              />
            )}
            <ChatInput
              ref={inputRef}
              value={direct.active ? direct.value : input}
              onChange={direct.active ? direct.onChange : (e) => updateInput(e.target.value)}
              onCompositionStart={direct.active ? direct.onCompositionStart : undefined}
              onCompositionEnd={direct.active ? direct.onCompositionEnd : undefined}
              onKeyDown={direct.active ? direct.onKeyDown : onInputKeyDown(onSendClick)}
              onBlur={direct.onBlur}
              onPaste={onPasteImage}
              placeholder={placeholder}
              autoCorrect={direct.active ? "off" : undefined}
              spellCheck={direct.active ? false : undefined}
              className={cn(
                // Room for the + tucked into the bottom-left of the field. `block` matters: a textarea
                // is inline-level by default, so the wrapper inherits a few px of baseline gap beneath
                // it and the absolutely-positioned button hangs past the field's bottom edge.
                "block rounded-2xl pl-11 pr-2",
                direct.active && "border-you focus-visible:border-you focus-visible:ring-you/30",
                showDesktopStrip && "opacity-0",
              )}
              disabled={locked}
              rows={1}
            />
            <ComposerMenu
              locked={locked}
              uploading={uploading}
              direct={{
                active: direct.active,
                disabled: locked || sending,
                onStart: () => direct.activate(),
                onStop: () => direct.deactivate(),
              }}
              showTerminal={prefs.showTerminal}
              onToggleTerminal={() => setShowTerminal(!prefs.showTerminal)}
              hasCommands={commands.length > 0}
              onAttach={() => fileRef.current?.click()}
              onDrawer={requestDrawer}
            />
            {showDesktopStrip && (
              <div
                data-direct-strip=""
                className="absolute inset-0 flex items-center rounded-md border border-you bg-background px-2"
              >
                <DirectTypingStrip
                  onStop={() => direct.deactivate()}
                  disabled={!direct.active && !(pathHold?.kind === "path" && stripReason === null)}
                  reason={stripReason ?? undefined}
                />
              </div>
            )}
          </div>
          {!showDesktopStrip &&
            (!direct.active && forcingSend ? (
              // The pre-flight refused and the user is being offered the override. Labelled for what it
              // actually does — TYPE the text into whatever is on screen — not "send", because the
              // submit key is still conditional on the verify step behind it.
              <Button
                variant="destructive"
                className="h-11 shrink-0 rounded-full px-4 text-sm font-semibold"
                onClick={onSendClick}
                disabled={locked || !input.trim() || sending}
                aria-label="Type anyway?"
              >
                Type anyway?
              </Button>
            ) : !direct.active && confirmingSend ? (
              <Button
                variant="destructive"
                className="h-11 shrink-0 rounded-full px-4 text-sm font-semibold"
                onClick={onSendClick}
                disabled={locked || !input.trim() || sending}
                aria-label="Really send?"
              >
                Really send?
              </Button>
            ) : (
              <Button
                size="icon"
                className="size-11 shrink-0 rounded-lg border-2 border-you bg-you text-you-foreground hover:bg-you/90"
                onClick={direct.active ? () => direct.deactivate() : onSendClick}
                disabled={locked || sending}
                aria-label={direct.active ? "Stop typing into terminal" : "Send"}
                aria-pressed={direct.active}
              >
                {direct.active ? (
                  <Keyboard className="size-4" />
                ) : sending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : justSent ? (
                  <Check className="size-4" />
                ) : (
                  <Send className="size-4" />
                )}
              </Button>
            ))}
        </div>
      </div>
    </>
  );
});
