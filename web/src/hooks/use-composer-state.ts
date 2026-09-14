import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from "react";
import { useRevalidator } from "react-router";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useDirectTyping } from "@/hooks/use-direct-typing";
import { useWheelPrefs } from "@/hooks/use-wheel-prefs";
import { useDesktop } from "@/lib/desktop";
import { usePasteHold } from "@/lib/paste-hold";
import { isSelfEcho, normalizeDraft } from "@/hooks/use-terminal-draft";
import { adapterFor } from "@/lib/harness";
import * as api from "@/lib/api";
import { commandsFor } from "@/lib/agent-commands";
import { useOperatorCommands, useOperatorKeys, useOperatorWheel } from "@/lib/operator-commands";
import { ctrlPresetsFor } from "@/lib/operator-keys";
import { wheelSlicesFor } from "@/lib/wheel";
import { setStatus } from "@/lib/status";
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts";
import { onArmToggleRequest } from "@/lib/direct-arm";
import type { PromptSelectBlock } from "@/lib/blocks";
import type { PromptBlockAction } from "@/components/prompt-select-block";
type ComposerDrawer = "cmd" | "keys" | "display" | null;
export interface ComposerStateArgs {
  paneId: string;
  agent: string | undefined | null;
  isShell: boolean;
  gone: boolean;
  readOnly: boolean;
  /** Latest pane text. Unused since the "You sent:" strip went; kept so callers stay unchanged. */
  text: string;
  dialogPresent: boolean;
  agentBlocked: boolean;
  terminalDraft: string | null;
  rawTerminalDraft: string | null;
  promptBlock?: PromptSelectBlock;
  onPromptAction?: (
    a: PromptBlockAction,
    p: PromptSelectBlock["prompt"],
  ) => Promise<boolean>;
  onArmedChange?: (armed: boolean) => void;
}
export const PASS_THROUGH_KEYS: Readonly<Record<string, string>> = {
  Escape: "Escape",
  Tab: "Tab",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};
export function useComposerState(args: ComposerStateArgs) {
  const {
    paneId,
    agent,
    isShell,
    gone,
    readOnly,
    dialogPresent,
    agentBlocked,
    terminalDraft,
    promptBlock,
    onPromptAction,
    rawTerminalDraft,
    onArmedChange,
  } = args;
  const revalidator = useRevalidator();
  // Herdr's +-joined key grammar for empty desktop composer pass-through.

  // Grace window after a send during which a terminal draft matching what we just sent is treated as
  // our own in-flight reply (still on the "❯" line before the bridge's pending Enter lands), NOT a
  // stranded draft. Wide enough to cover a slow tailnet round-trip; the parent's cross-poll
  // stabilisation (useStableTerminalDraft) closes the other half of the same window.
  const SENT_ECHO_GRACE_MS = 5_000;

  // Burst window for post-keypress revalidation (see scheduleKeyRevalidate).
  const KEY_REVALIDATE_MS = 300;
  // Every write affordance is off when the pane is gone OR this device is read-only.
  const locked = gone || readOnly;
  // …and a ref alongside it, for the ONE caller that reads it after an await. `send()` checks
  // `locked` once, up front, but its pre-clear sweep goes out on the far side of the pre-flight's
  // pane read; a re-render that locks the composer in that window must be able to stop the most
  // destructive keys this component sends. Every other write affordance is either disabled by React
  // or funnelled through `pressKeys`, which is synchronous with its own check.
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  // The phone-owned draft, restored from (and written through to) the per-pane draft store — the
  // pane view is keyed by paneId, so without this, stepping over to another tab mid-reply ate the
  // message. Lazy initialiser so the restore happens on the mount, before first paint.
  const [input, setInput] = useState(() => loadDraft(paneId) ?? "");
  // Mirror of `input` for the write-through path: updateInput needs the previous value to apply a
  // functional update AND to persist the result, without either reading stale state or doing the
  // save inside a (double-invoked) state updater.
  const inputValueRef = useRef(input);
  // Which pane the current `input` belongs to. DetailRoute keys AgentChat by paneId, so in the app a
  // pane→pane navigation remounts this component and the lazy initialiser above does the work — but
  // the component must not depend on that: if it is ever rendered with a changed paneId in
  // place, the effect below saves the outgoing pane's draft and loads the incoming one, so pane A's
  // text can never surface in pane B.
  const draftPaneRef = useRef({ paneId });

  /**
   * Set the draft AND persist it. Every write to `input` goes through here — an empty value removes
   * the stored key, so the deliberate-clear paths (verified send, user emptying the box) need no
   * special case.
   *
   * PERSISTENCE STOPS while a password prompt is on screen (collie#103). By the time the notice appears the
   * secret is already in the 48h store — the write-through ran on every keystroke, before any send was
   * attempted — so `noEchoRef` gates the save AND the pane-leave save below, and the outcome that sets
   * it removes the stored copy outright. The button was never enough: the operator who taps Send,
   * gives up and walks to a laptop (which is exactly what collie#103 reports doing, for three days) never
   * presses anything, and the pane-leave path would have re-saved it on the way out.
   *
   * Gating on a REF, not the state, because the two must change in the same tick as the outcome that
   * decides it — a render behind is a render in which the next keystroke is still being stored.
   * The in-memory draft is untouched: a false positive costs one draft its ability to survive the OS
   * killing the PWA, which is a cheap price for never storing a real one.
   */
  function updateInput(next: string | ((prev: string) => string)) {
    const value =
      typeof next === "function" ? next(inputValueRef.current) : next;
    inputValueRef.current = value;
    setInput(value);
    if (noEchoRef.current !== null) return;
    saveDraft(paneId, value);
  }

  useEffect(() => {
    const prev = draftPaneRef.current;
    if (prev.paneId === paneId) return;
    if (noEchoRef.current === null)
      saveDraft(prev.paneId, inputValueRef.current);
    draftPaneRef.current = { paneId };
    const restored = loadDraft(paneId) ?? "";
    inputValueRef.current = restored;
    setInput(restored);
    noticeNoEcho(null); // it described the pane we just left
  }, [paneId]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [justSent, setJustSent] = useState(false); // brief ✓ on the send button after a send
  // Terminal-draft preview bookkeeping. The composer input is EXCLUSIVELY phone-owned — a host draft
  // is never written into it implicitly; it only surfaces in a read-only preview the user can
  // deliberately Take over. There is no user-facing dismiss — the preview is honest state (a draft
  // really is stranded on the host's line), so it stays visible until the host line clears, the user
  // takes it over, or the user sends. `handledKey` is the NORMALISED text the user has handled (took
  // over or sent) — the preview stays hidden while the live draft still normalises to it, so it can't
  // re-latch onto the same text we just copied/sent (the raw line still holds it until the host clears
  // or Enter lands); a genuinely different draft is fair game again. `previewLatched` is the show/hide
  // latch: a STABLE draft flips it on (gating appearance behind the 1.5s stability), and it stays on —
  // its text tracking the RAW draft live — until the host line clears or the user acts (see the effects
  // below).
  const [handledKey, setHandledKey] = useState<string | null>(null);
  const [previewLatched, setPreviewLatched] = useState(false);
  // Composer sheets are mutually exclusive — at most one open (Keys / Agent / Display).
  const [drawer, setDrawer] = useState<ComposerDrawer>(null);
  // Keys staged in the (unmounted-on-close) NavTray, pushed up so leaving the Keys dock can guard a
  // composed sequence. See requestDrawer.
  const [queuedKeys, setQueuedKeys] = useState(0);
  // Two-tap guard for discarding that sequence. Separate from sendConfirm so an armed "Really send?"
  // and an armed discard can't clobber each other.
  const discardConfirm = usePendingConfirm();

  // The SINGLE choke point for every drawer transition. Closing the Keys dock destroys the composed
  // queue (NavTray unmounts, useKeyQueue resets) — deliberate, because a queue that survived into a
  // later open would let Send fire yesterday's chord sequence into today's TUI state, and this
  // surface's whole safety story is "you review exactly what is about to go on the wire". So the fix
  // for a mis-tap is a confirm, not persistence.
  //
  // Routed through here rather than guarding the dock's ✕ alone: the Keys toggle and the other drawer toggles /
  // Agent / Display buttons all unmount the tray just as effectively. An armed-but-EMPTY queue (a
  // lone `once` modifier, no chips) does not arm the confirm — one tap of setup isn't work worth
  // protecting, and over-guarding just trains you to double-tap through it reflexively.
  function requestDrawer(next: ComposerDrawer) {
    if (
      drawer === "keys" &&
      next !== "keys" &&
      queuedKeys > 0 &&
      !discardConfirm.confirm("discard")
    ) {
      setStatus(
        `Tap again to discard ${queuedKeys} queued key${queuedKeys === 1 ? "" : "s"}`,
        "info",
      );
      return;
    }
    discardConfirm.reset();
    setDrawer(next);
  }
  const closeDrawer = () => requestDrawer(null);
  // Two-tap guard for destructive commands (rm -rf, force-push, …): the first tap arms a "Really
  // send?" state on the Send button (auto-disarms after 3 s), the second actually sends. Same shared
  // confirm the command palette uses for /clear.
  const sendConfirm = usePendingConfirm();
  // Two-tap override for a `blocked` pre-flight ("the input box isn't on screen"). Separate from
  // sendConfirm so a destructive-command confirm and an override can't clobber each other, and given
  // a longer window than the 3s default: unlike "Really send?", this one asks you to read a sentence
  // explaining WHY nothing was typed before deciding to overrule it.
  const forceConfirm = usePendingConfirm(10_000);

  // The password prompt the last refused send was looking at, if it was one (collie#103). Set from the
  // guard's own live read — never re-derived from `display`, which is a snapshot — and cleared by the
  // ✕, by arming Type, by a send that goes through, and by leaving the pane. Not persisted: it is a
  // statement about what is on screen right now.
  //
  // It is state AND a ref because it has two jobs on two clocks: the strip renders from the state,
  // while the draft write-through (updateInput, above) has to stop storing keystrokes in the same tick
  // the outcome lands, not on the render after. `noticeNoEcho` is the only writer of both — go through
  // it, or the two disagree and the gap is measured in stored passwords.
  const [noEcho, setNoEcho] = useState<{
    prompt: string;
    typed: boolean;
  } | null>(null);
  const noEchoRef = useRef<{ prompt: string; typed: boolean } | null>(null);

  /** Raise or clear the password-prompt notice. Raising it also DROPS the stored draft: at that moment
   *  we know the field holds a secret the pane never accepted, and leaving it in a 48h store to be
   *  restored on the next visit is the leak collie#103 asked about. The in-memory value stays — the operator
   *  can still read it, hand it to Type, or dismiss the notice and carry on. */
  function noticeNoEcho(next: { prompt: string; typed: boolean } | null) {
    noEchoRef.current = next;
    setNoEcho(next);
    if (next !== null) clearDraft(paneId);
  }

  const { on: desktop, typing } = useDesktop();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const direct = useDirectTyping({
    paneKey: paneId,
    inputRef,
    // The ref, not `input`: the password-prompt handoff clears the draft and arms in one tick.
    replyDraft: () => inputValueRef.current,
    canActivate: () => !(locked || sending || uploading),
    // `locked` covers a gone pane and a read-only device. A LOST CONNECTION is
    // deliberately not added here: the mode already disarms on a failed batch, which is the same
    // event observed directly rather than inferred from a timer, and it fires whether or not any
    // banner has decided the connection counts as lost yet.
    suspended: locked,
    sendKeys: pressKeys,
    onActivate: () => {
      sendConfirm.reset();
      forceConfirm.reset();
      noticeNoEcho(null); // the notice's whole job was to get you here
    },
    focusInput: focusInputEnd,
    desktop,
  });
  // Clears the ✓ on the Send button 1.5s after a send.
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What we last sent, and when — so we can recognise our OWN reply momentarily echoing on the "❯"
  // line (during the bridge's send_text→settle→Enter gap) and NOT treat it as a stranded draft. A
  // ref, not state: it feeds a render-time derivation but must not itself trigger re-renders.
  const lastSentRef = useRef<{ text: string; at: number } | null>(null);
  // Trailing-edge debounce for post-keypress revalidation: a burst of raw key sends (arrow-key
  // spam) coalesces into a single pane refetch instead of one per press.
  const keyRevalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The pane's harness adapter, resolved HERE (this is where the agent is known) so the neutral
  // draft helpers below stay harness-free: they take the capability, never the grammar. Undefined for
  // any agent without an adapter, which is exactly the "no idea" case those helpers already handle.
  const adapter = adapterFor(agent ?? undefined);

  // Guard against a false stranded-draft: if the detected draft is what we JUST sent, it's our own
  // reply still echoing on the "❯" line before the bridge's pending Enter — suppress both the preview
  // AND the destructive clear-prefix on the next Send. Applied to the raw and the stabilised value
  // alike (during the echo both carry our text). Recomputed each render (each poll re-renders), so it
  // lapses on its own once the grace expires or the echo resolves; a genuinely stranded draft (never
  // matches a recent send) is untouched.
  const suppressEcho = (draft: string | null): string | null => {
    if (
      draft !== null &&
      lastSentRef.current !== null &&
      Date.now() - lastSentRef.current.at < SENT_ECHO_GRACE_MS &&
      isSelfEcho(draft, lastSentRef.current.text, adapter?.draftCarriesSend)
    ) {
      return null;
    }
    return draft;
  };
  // effectiveStable gates the preview's APPEARANCE (stabilised value); effectiveRaw is the live line
  // its text tracks and that the send()-time pre-clear sweeps.
  const effectiveStable = suppressEcho(terminalDraft);
  const effectiveRaw = suppressEcho(rawTerminalDraft);
  const stripReason = gone
    ? "pane is gone"
    : readOnly
      ? "read-only device"
      : null;
  const directRef = useRef(direct);
  directRef.current = direct;
  const pathHold = usePasteHold();
  const showDesktopStrip =
    desktop &&
    (direct.active ||
      (pathHold?.kind === "path" && stripReason === null) ||
      (typing === "direct" && stripReason !== null));
  const showYesNo =
    agentBlocked &&
    !dialogPresent &&
    !isShell &&
    !locked &&
    !direct.active &&
    !sending;
  function toggleDirect() {
    const d = directRef.current;
    if (d.active) d.deactivate();
    else d.activate();
  }
  useEffect(() => {
    onArmedChange?.(direct.active);
  }, [direct.active]);

  useEffect(() => {
    if (!desktop) return;
    return onArmToggleRequest(toggleDirect);
  }, [desktop]);

  useEffect(
    () => () => {
      if (sentTimer.current) clearTimeout(sentTimer.current);
      if (keyRevalidateTimer.current) clearTimeout(keyRevalidateTimer.current);
    },
    [],
  );

  // Preview appearance latch. A STABLE, non-echo, not-already-handled draft flips the preview on —
  // this is the ONLY gate that waits for the 1.5s stability, so a blip or an in-flight send never
  // flashes it. Deliberately one-directional: once latched, rapid host typing (which keeps blanking
  // the stabilised value) can't turn it back off — the raw-tracking + unlatch effects own the hide
  // side. Skipped when the pane is gone.
  useEffect(() => {
    if (gone) return;
    if (
      effectiveStable !== null &&
      normalizeDraft(effectiveStable) !== handledKey
    ) {
      setPreviewLatched(true);
    }
  }, [effectiveStable, handledKey, gone]);

  // Unlatch when the host clears the "❯" line — the draft was submitted or wiped on the host, or our
  // own send echoed back and got suppressed to null. The preview unmounts on the next render. Also
  // forget the handled key: it exists only to stop the JUST-handled text re-latching before the line
  // clears — once the line has actually emptied, a later re-strand of the same text is a fresh draft
  // and must surface again (without this, taking over "continue" once muted every future "continue"
  // in the pane until you navigated away).
  useEffect(() => {
    if (effectiveRaw === null) {
      setPreviewLatched(false);
      setHandledKey(null);
    }
  }, [effectiveRaw]);

  // Show the preview while it's latched, the host line still carries a (non-echo) draft, and the user
  // hasn't already handled this exact text. Its displayed text is the LIVE raw line — host typing
  // streams straight into it (display-only; it can never write back into the phone-owned input). There
  // is no dismiss action — this is the ONLY way the preview hides short of the host line itself
  // clearing, since a draft that still normalises to `handledKey` is the one the user just took over
  // or sent, not a fresh one to re-show. Not gated on `locked`: read-only devices get the preview +
  // Take over (a local text copy); only the actual Send stays gated.
  const showPreview =
    !gone &&
    previewLatched &&
    effectiveRaw !== null &&
    normalizeDraft(effectiveRaw) !== handledKey;

  // Take over: the explicit "I'll handle this on mobile now" action. One-shot COPY of the current raw
  // draft into the composer (set on an empty input, else appended on a new line so mobile-typed work
  // survives), mark that exact text handled (so it can't instantly re-latch the preview — the raw line
  // still holds it until the host clears it), and hide the preview. No keys touch the terminal here —
  // the stranded line is only ever swept by the send()-time pre-clear. If the host keeps typing and
  // produces a DIFFERENT draft afterwards, the preview honestly reappears with the new text.
  function takeOverDraft() {
    if (effectiveRaw === null) return;
    const draft = effectiveRaw;
    direct.deactivateSilently();
    updateInput((prev) =>
      prev.trim() ? `${prev.trimEnd()}\n${draft}` : draft,
    );
    setHandledKey(normalizeDraft(draft));
    setPreviewLatched(false);
    focusInputEnd();
  }

  // The operator's own palette rows, resolved against the shipped catalog for both the button's
  // visibility test here and the palette's own list below (same call, same arguments).
  const operatorCommands = useOperatorCommands();
  const commands = commandsFor(agent, operatorCommands);
  const keyPresets = ctrlPresetsFor(agent, useOperatorKeys());
  const { picks } = useWheelPrefs();
  const wheelSlices = wheelSlicesFor(useOperatorWheel(), picks, keyPresets);

  function focusInputImmediately() {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  function focusInputEnd() {
    setTimeout(focusInputImmediately, 0);
  }
  const confirmingSend = sendConfirm.pending === "send";
  const forcingSend = forceConfirm.pending === "force";
  // Type is the NEXT action when a password / no-echo prompt just refused a send, when the "type
  // anyway" override is armed (the composer isn't on screen, so keys are the only way in), or when
  // it is already armed. Kept for callers that want to surface Type early; the + menu offers it
  // whenever the phone is not already armed (#205, then the composer redesign).
  const showTypeControl =
    !desktop && (noEcho !== null || forcingSend || direct.active);

  // Coalesce revalidations from a burst of key presses, LEADING edge first: the first press in a
  // burst refetches immediately, and only presses that arrive inside the window collapse into one
  // trailing refetch. It used to be trailing-only, which meant a lone press — the common case — sat
  // out the full window before its fetch even *started*, and if that fetch then beat the TUI's
  // repaint you waited a whole 1.5s poll to see anything. Arrow-key spam still coalesces exactly as
  // before: presses 2..n only ever schedule the one trailing refetch.
  function scheduleKeyRevalidate() {
    if (keyRevalidateTimer.current === null) {
      revalidator.revalidate(); // leading edge
      // Cooldown only — it fires nothing itself; a press landing before it expires replaces it with
      // the trailing refetch below.
      keyRevalidateTimer.current = setTimeout(() => {
        keyRevalidateTimer.current = null;
      }, KEY_REVALIDATE_MS);
      return;
    }
    clearTimeout(keyRevalidateTimer.current);
    keyRevalidateTimer.current = setTimeout(() => {
      keyRevalidateTimer.current = null;
      revalidator.revalidate(); // trailing edge — one refetch for the whole burst
    }, KEY_REVALIDATE_MS);
  }

  // Raw key send (nav tray). Resolves the bridge's verdict so the pressed button can echo it — the
  // mirror is still the source of truth for what the key DID, but it can be ~2s behind, and this
  // path used to be silent on success, so a press looked like it went nowhere. Errors still go to
  // the status channel; the echo just falls back to idle.
  async function pressKeys(k: string[]): Promise<boolean> {
    if (locked) return false;
    try {
      const res = await api.sendKeys(paneId, k);
      if (!res.ok) {
        setStatus(res.error ?? "Key send failed", "error");
        return false;
      }
      scheduleKeyRevalidate();
      return true;
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
      return false;
    }
  }

  // Insert "/cmd " into the composer (arg-taking commands) and focus it. Appends to any draft already
  // typed (with a separating space) rather than clobbering it; an empty draft just gets set.
  function insertCommand(value: string) {
    direct.deactivateSilently();
    updateInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${value}` : value));
    focusInputEnd();
  }

  // Upload an image; on success append its host path to the composer so the user can add context.
  // Shared by the file picker and clipboard paste.
  async function uploadImage(file: File) {
    if (locked) return;
    setUploading(true);
    try {
      const res = await api.uploadImage(paneId, file);
      if (res.ok) {
        const path = res.path;
        direct.deactivateSilently();
        updateInput((prev) =>
          prev.trim() ? `${prev.trimEnd()} ${path}` : path,
        );
        focusInputEnd();
        setStatus("Image added — path in message", "success");
      } else {
        setStatus(res.error, "error");
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setUploading(false);
    }
  }

  async function onPickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    await uploadImage(file);
  }

  // Paste an image straight from the clipboard (e.g. a screenshot) the same way the picker does.
  // Only intercepts when the clipboard actually carries an image file — a plain text paste (the
  // common case) falls through untouched.
  function onPasteImage(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (locked || direct.active) return;
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void uploadImage(file);
          return;
        }
      }
    }
  }
  // The composer's placeholder, derived here rather than as a six-arm ternary inside the JSX — same
  // arms, same copy, same order as before. `gone` and `readOnly` come first because they are the two
  // states in which the box cannot be typed into at all, and the placeholder is the only thing that
  // says so.
  const placeholder = gone
    ? "Pane is gone"
    : readOnly
      ? "Read-only — device not authorised"
      : direct.active
        ? "Type into the terminal…"
        : isShell
          ? desktop
            ? "Type a shell command… · Enter sends · Shift+Enter newline · Ctrl+` type direct"
            : "Type a shell command…"
          : desktop
            ? "Type a reply… · Enter sends · Shift+Enter newline · Ctrl+` type direct"
            : "Type a reply…";

  // Desktop keyboard handling for the composer's textarea. It lives here, not in the JSX, because it
  // is 40 lines of branching that had to be joined onto one line to fit the file's budget — and a
  // keyboard map is exactly the thing you want to read as a list. Takes `onSendClick` because
  // composer.tsx owns `send()`; this hook only owns the keys that reach it.
  function onInputKeyDown(onSendClick: () => void) {
    return (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onSendClick();
        return;
      }
      if (!desktop) return;
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        onSendClick();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || input.length !== 0) return;
      // Shift+Tab is Claude's mode cycle. Other Shift chords stay with the browser.
      if (e.shiftKey && e.key !== "Tab") return;
      if (/^[0-9]$/.test(e.key)) {
        if (!dialogPresent) return;
        e.preventDefault();
        if (promptBlock && onPromptAction) {
          if (promptBlock.prompt.feedback?.focused) {
            setStatus("Use the buttons for this dialog", "warn");
            return;
          }
          const option = promptBlock.prompt.options.find((o) => o.keys[0] === e.key);
          if (option) {
            void onPromptAction({ kind: "option", option }, promptBlock.prompt);
          } else {
            setStatus(`No option ${e.key}`, "warn");
          }
        } else if (dialogPresent) {
          setStatus("Use the buttons for this dialog", "warn");
        }
        return;
      }
      const key = PASS_THROUGH_KEYS[e.key];
      if (key === undefined) return;
      e.preventDefault();
      pressKeys([e.shiftKey ? "shift+Tab" : key]);
    };
  }

  return {
    input,
    updateInput,
    sending,
    setSending,
    uploading,
    setUploading,
    desktop,
    directRef,
    toggleDirect,
    justSent,
    setJustSent,
    lastSentRef,
    sentTimer,
    handledKey,
    setHandledKey,
    previewLatched,
    setPreviewLatched,
    drawer,
    requestDrawer,
    closeDrawer,
    queuedKeys,
    setQueuedKeys,
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
    focusInputEnd,
    direct,
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
    showTypeControl,
    confirmingSend,
    forcingSend,
    insertCommand,
    onPickImage,
    onPasteImage,
    onInputKeyDown,
    placeholder,
  };
}
