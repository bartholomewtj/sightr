/**
 * The thread's composer (T12), on the structure of T3's `ChatComposer`: a banner stack and the queued
 * list above the box, the slash menu attached to it, the primary actions beside it, and the pending
 * request panel in its place when the agent asks something. T3 builds the box on a rich editor; Sightr
 * keeps a plain `<textarea>` so phone dictation and IMEs work (README: Tiptap is not taken).
 *
 * The browser never types into the pane: every send is a `message.dispatch` command, and the bridge
 * runs the send guard (T06). The draft survives reloads and failed commands; it clears only on the
 * bridge's reply.
 */
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import {
  AlarmClockIcon,
  CircleCheckIcon,
  ImageIcon,
  KeyboardIcon,
  ListOrderedIcon,
  Loader2Icon,
  LockIcon,
  PaperclipIcon,
  PencilIcon,
  RotateCwIcon,
  ShieldAlertIcon,
  ServerOffIcon,
  TriangleAlertIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";

import { launchFor } from "@shared/agents";
import type { QueuedMessage, RuntimeRequest } from "@shared/v2/contracts";
import { commandsFor } from "@v1/lib/agent-commands";
import { isDestructiveInput } from "@v1/lib/destructive";
import { ctrlPresetsFor } from "@v1/lib/operator-keys";
import { cn } from "~/lib/utils";
import { currentShortcutContext } from "@/components/GlobalShortcuts";
import { NavTray } from "@/components/keys/nav-tray";
import { useDropUpload } from "@/hooks/use-drop-upload";
import { useLayout } from "@/hooks/useLayout";
import { KEYBINDINGS, resolveShortcutCommand } from "@/keybindings";
import { sendKeys } from "@/lib/api";
import { loadDraft, saveDraft } from "@/lib/drafts";
import { appendReviewBlocks } from "@/lib/reviewCommentContext";
import { showToast } from "@/components/toast";
import { useOperatorCommands, useOperatorKeys } from "@/lib/operator-commands";
import { useShortcutHandler } from "@/shortcutHandlers";
import { snoozeWakeLabel } from "@/components/Sidebar.snooze";
import { performThreadCommand, useSidebarThread } from "@/state/sidebar";
import {
  addAttachments,
  attachmentFile,
  consumeInsert,
  dispatchMessage,
  endQueuedEdit,
  getThreadComposer,
  interruptRun,
  patchComposer,
  publishComposerText,
  readyAttachments,
  removeAttachment,
  respondToRequest,
  retryAttachment,
  saveQueuedEdit,
  sentMessage,
  setPermissionMode,
  settleUploads,
  startQueuedEdit,
  useComposerSettings,
  useThreadComposer,
  type AttachmentChip,
} from "@/state/composer";
import { V2CommandError } from "@/stream/commands";
import { dismissQueueAutoResume, useBridgeInfo, useStreamHealth, useThread } from "@/stream/stores";
import { Button } from "../ui/button";
import {
  composerMaxHeight,
  enterModeFor,
  isCompacting,
  isLargePaste,
  MAX_COMPOSER_CHARS,
  permissionModeBlock,
  permissionModeOptions,
  permissionModeRefusalText,
  promptLengthMessage,
  queueAutoResumeText,
  resolveComposerButtons,
  resolveEnterAction,
  slashQuery,
  threadStatusLine,
  wantsEditNewest,
  workingMode,
} from "./ChatComposer.logic";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerImageThumbnail } from "./ComposerImageThumbnail";
import { ComposerPromptLengthValidation } from "./ComposerPromptLengthValidation";
import { ExpandedImageDialog, type ExpandedImagePreview } from "./ExpandedImageDialog";
import { ThreadStatusLine } from "./ThreadStatusLine";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";
import { ComposerCommandMenu, composerSuggestionOptionId, toCommandItems, type ComposerCommandItem } from "./ComposerCommandMenu";
import { ComposerDecisionPanel } from "./ComposerDecisionPanel";
import { isWhistlrDecision, replyToDecision } from "@/state/decision-reply";
import { GestureWheel } from "@/components/keys/gesture-wheel";
import { useWheelPrefs } from "@/hooks/use-wheel-prefs";
import { useOperatorWheel } from "@/lib/operator-commands";
import { useRightPanelStore } from "@/rightPanelStore";
import { openThreadTerminal } from "@/threadViewStore";
import { wheelSlicesFor } from "@v1/lib/wheel";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ReviewCommentsBar } from "./ReviewCommentsBar";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import { QueuedRunsControl, type QueuedRunsControlHandle } from "./QueuedRunsControl";
import { activeComposerTasks, latestRunError } from "./ComposerStatus.logic";
import { ComposerTasksBadge, ComposerTasksSheet } from "./ComposerTasksBadge";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { contextWindowSnapshot, manualCompactionCommand } from "./ContextWindowMeter.logic";
import {
  dismissThreadErrorBanner,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissed,
  threadErrorBannerItem,
  useDismissedThreadErrors,
} from "./ThreadErrorBanner";
import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

/** The file picker's accept list, as v1's composer. */
export const ATTACH_ACCEPT =
  "image/*,text/*,.md,.markdown,.txt,.json,.jsonl,.yaml,.yml,.toml,.csv,.tsv,.log,.xml,.html,.htm,.css,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.go,.rs,.sh,.bash,.ps1,.sql,.diff,.patch";

/** How long the destructive-text guard stays armed (v1's `usePendingConfirm` default). */
const ARM_MS = 3_000;
/** Eight lines, then the box scrolls. */
const MAX_LINES = 8;

const DISPATCH_REASON: Record<string, string> = {
  blocked: "The agent's input box was not on screen. Nothing was sent.",
  stalled: "The text did not reach the agent's input box. Nothing was sent.",
  error: "The send failed.",
  "pane-gone": "The pane is gone.",
  busy: "The pane was busy.",
  "interrupt-failed": "Steer could not stop the agent.",
  "interrupt-timeout": "Steer gave up waiting for the agent to stop.",
};

/** The request the panel shows: the oldest pending one. */
function pendingRequests(requests: Record<string, RuntimeRequest> | undefined): RuntimeRequest[] {
  return Object.values(requests ?? {})
    .filter((r) => r.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt);
}

const COARSE_QUERY = "(pointer: coarse)";

/** A touch screen is the primary pointer: Enter adds a line (the send button sends), the keyboard is on screen while typing. */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(COARSE_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(COARSE_QUERY);
    const on = () => setCoarse(mql.matches);
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, []);
  return coarse;
}

/** The wall clock, to the half minute, while `on` (a status line that reads the clock redraws as time passes). */
function useMinuteClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

/** Ctrl/⌘ held anywhere on the page (T3's shortcut modifier state), for the live Queue/Steer label. */
function useAlternateModifier(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    // Pointer events carry the modifier state too, so a Ctrl whose keyup never came (a shortcut that
    // moved focus, text inserted without key events) is corrected as soon as the pointer moves.
    const on = (e: globalThis.KeyboardEvent | globalThis.PointerEvent) => setHeld(e.ctrlKey || e.metaKey);
    const off = () => setHeld(false);
    window.addEventListener("keydown", on);
    window.addEventListener("keyup", on);
    window.addEventListener("pointermove", on);
    window.addEventListener("pointerdown", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("keyup", on);
      window.removeEventListener("pointermove", on);
      window.removeEventListener("pointerdown", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  return held;
}

export function ChatComposer({ threadId }: { threadId: string }) {
  const layout = useLayout();
  const state = useThread(threadId);
  const shellThread = useSidebarThread(threadId);
  const thread = state?.thread ?? shellThread ?? null;
  const paneId = thread?.paneId ?? "";
  const linkLost = useStreamHealth((s) => s.status === "lost");
  const herdr = useBridgeInfo((s) => s.herdr);
  const readOnly = useBridgeInfo((s) => s.readOnly);
  const composer = useThreadComposer(threadId);
  const storedEnter = useComposerSettings((s) => s.enterMode);
  const followUp = useComposerSettings((s) => s.followUp);
  const coarse = useCoarsePointer();
  // Phone first: on a touch screen (a phone, or a tablet wide enough for the desktop layout) Enter is a
  // newline by default, so dictation and multi-line messages never send half-done.
  const enterMode = enterModeFor(storedEnter, layout, coarse);
  const alternate = useAlternateModifier();
  const operatorCommands = useOperatorCommands();
  const operatorKeys = useOperatorKeys();
  // T19: the phone's gesture wheel beside Send (this device's picks > keys.toml [[wheel]] > shipped).
  const wheelPicks = useWheelPrefs().picks;
  const operatorWheel = useOperatorWheel();

  const [text, setTextState] = useState(() => loadDraft(threadId) ?? "");
  const textRef = useRef(text);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<QueuedRunsControlHandle>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const boxFocused = useRef(false);
  // The box has focus on a touch screen: the soft keyboard is up and covers the home indicator, so the
  // safe-area padding under the composer would only be a gap above the keyboard.
  const [typing, setTyping] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [armedCommand, setArmedCommand] = useState<string | null>(null);
  const [dismissedRun, setDismissedRun] = useState<string | null>(null);
  /** A destructive permission mode picked from the menu, waiting for its confirm tap. */
  const [confirmMode, setConfirmMode] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ExpandedImagePreview | null>(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  const dismissedErrors = useDismissedThreadErrors((s) => s.keys);
  const listId = useId();

  const editing = composer.editing;
  const queue: readonly QueuedMessage[] = state?.queue ?? [];
  const requests = pendingRequests(state?.requests);
  const request = requests[0] ?? null;
  const uploading = composer.attachments.some((c) => c.status === "uploading");
  const hasContent = text.trim() !== "" || readyAttachments(composer.attachments).length > 0;
  // T3 #20184: a `/compact` run cannot take steering; follow-ups queue (the bridge enforces it too).
  const runs = state?.runs;
  const items = state?.items;
  const threadCompacting = thread?.compacting === true;
  const compacting = useMemo(
    () => (runs && items ? isCompacting({ runs, items, thread: { compacting: threadCompacting } }) : threadCompacting),
    [runs, items, threadCompacting],
  );
  const canSteer = !compacting;

  const setText = (next: string, persist = true) => {
    textRef.current = next;
    setTextState(next);
    publishComposerText(threadId, next);
    if (persist && !getThreadComposer(threadId).editing) saveDraft(threadId, next);
  };
  // T29: tell the review-comment list what the box holds (for its "in message" marks) from the start.
  useEffect(() => publishComposerText(threadId, textRef.current), [threadId]);

  // ── Review comments to append (T29): the list or the row above the box asked; the text goes through setText ──
  const insertion = composer.insertion;
  useEffect(() => {
    if (!insertion) return;
    consumeInsert(threadId, insertion.id);
    const { text: next, added } = appendReviewBlocks(textRef.current, insertion.blocks);
    const total = insertion.blocks.length;
    const waiting = request !== null ? " The agent is asking something; your message is waiting." : "";
    if (added > 0 && next.length <= MAX_COMPOSER_CHARS) {
      setText(next);
      if (insertion.focus && request === null) boxRef.current?.focus();
    }
    const full = added > 0 && next.length > MAX_COMPOSER_CHARS;
    const done = added > 0 && !full ? added : 0;
    showToast(
      done === total
        ? `Added ${total} comment${total === 1 ? "" : "s"} to your message.${waiting}`
        : full
          ? `Your message is full. Send, then add the rest.${waiting}`
          : `Added ${done} of ${total}. Send, then add the rest.${waiting}`,
    );
  }, [insertion?.id]);

  const buttonInput = {
    thread,
    hasRequest: request !== null,
    hasText: hasContent,
    followUp,
    editing: editing !== null,
    busy: composer.busy === "send" || composer.busy === "edit" || composer.busy === "mode",
    linkLost,
    readOnly,
    uploading,
    canSteer,
  };
  const buttons = resolveComposerButtons({ ...buttonInput, alternate });
  const canSteerQueued = thread?.status === "working" && workingMode("steer", false, thread.capabilities, canSteer) === "steer";

  // ── Permission mode (T08): only when the thread's flags offer a live switch ──
  const harness = thread?.harness;
  const capabilities = thread?.capabilities;
  const modeOptions = useMemo(
    () => permissionModeOptions(capabilities, harness ? launchFor(harness)?.modes : undefined),
    [capabilities, harness],
  );
  const modeLabel = (id: string) => modeOptions?.find((o) => o.id === id)?.label ?? id;
  const modeBlocked = permissionModeBlock({
    thread,
    hasRequest: request !== null,
    busy: composer.busy !== null,
    readOnly,
    linkLost,
  });
  const describeModeRefusal = (err: unknown) =>
    err instanceof V2CommandError
      ? permissionModeRefusalText(err.body?.error, typeof err.body?.shown === "string" ? err.body.shown : undefined, modeLabel)
      : err instanceof Error && err.message
        ? err.message
        : "Could not reach the bridge.";
  function pickMode(mode: string): void {
    const option = modeOptions?.find((o) => o.id === mode);
    if (!option || modeBlocked) return;
    if (option.destructive) {
      setConfirmMode(mode);
      return;
    }
    setConfirmMode(null);
    void setPermissionMode(threadId, mode, { describe: describeModeRefusal });
  }
  function confirmDestructiveMode(): void {
    const mode = confirmMode;
    setConfirmMode(null);
    if (!mode || modeBlocked) return;
    void setPermissionMode(threadId, mode, { confirmBypass: true, describe: describeModeRefusal });
  }

  // ── Snoozed / settled line (T3's ThreadStatusLine) ──
  const restingShelf = thread?.shelf === "snoozed" || thread?.shelf === "settled";
  const clock = useMinuteClock(restingShelf);
  const statusLine = threadStatusLine(thread, clock, snoozeWakeLabel);
  const lengthMessage = promptLengthMessage(text);

  function openImage(chipId: string): void {
    const images = composer.attachments.filter((c) => c.image);
    const index = images.findIndex((c) => c.id === chipId);
    if (index < 0) return;
    // Object URLs for the open viewer only; revoked when it closes.
    const urls = images.map((c) => {
      const file = attachmentFile(c.id);
      return { src: file && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null, name: c.name };
    });
    setExpanded({ images: urls, index });
  }
  function closeImage(): void {
    setExpanded((open) => {
      for (const image of open?.images ?? []) if (image.src) URL.revokeObjectURL(image.src);
      return null;
    });
  }

  // ── Autosize: grow to eight lines (less when the keyboard leaves little room), then scroll ──
  useEffect(() => {
    const fit = () => {
      const el = boxRef.current;
      if (!el) return;
      el.style.height = "auto";
      const style = getComputedStyle(el);
      const max = composerMaxHeight(Number.parseFloat(style.lineHeight), MAX_LINES, Number.parseFloat(style.maxHeight));
      el.style.height = `${Math.min(el.scrollHeight, max)}px`;
      el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
    };
    fit();
    // The keyboard opening resizes the viewport (`interactive-widget=resizes-content`), and the box's
    // dvh cap with it.
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [text, request]);

  // ── The destructive guard disarms on its own ──
  useEffect(() => {
    if (armed === null) return;
    const id = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(id);
  }, [armed]);
  useEffect(() => {
    if (armedCommand === null) return;
    const id = setTimeout(() => setArmedCommand(null), ARM_MS);
    return () => clearTimeout(id);
  }, [armedCommand]);

  // ── A dispatch.failed: the banner, Retry with the same text, and the text back in an empty box ──
  const failure = state?.dispatchFailure ?? null;
  const seenFailure = useRef<number | null>(failure?.sequence ?? null);
  useEffect(() => {
    if (!failure || seenFailure.current === failure.sequence) return;
    seenFailure.current = failure.sequence;
    const sent = sentMessage(failure.commandId);
    const why = failure.message ?? DISPATCH_REASON[failure.reason] ?? failure.reason;
    if (failure.queuedId) {
      patchComposer(threadId, { error: { text: `A queued message was held: ${why}` } });
      return;
    }
    if (failure.textDelivered) {
      patchComposer(threadId, {
        error: { text: "The text reached the agent's input box but was not submitted. Check the terminal." },
      });
      return;
    }
    patchComposer(threadId, { error: { text: why, ...(sent ? { retry: { text: sent.text, attachments: sent.attachments } } : {}) } });
    if (sent && textRef.current.trim() === "" && !getThreadComposer(threadId).editing) setText(sent.text);
  }, [failure, threadId]);

  // ── Requests: focus rule, busy until it leaves `pending`, "Answered elsewhere" ──
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const prior = shown.current;
    shown.current = request?.id ?? null;
    if (request && prior !== request.id && !boxFocused.current) {
      // Never steal typing: only when the box did not have focus.
      firstOptionRef.current?.focus();
    }
    if (prior && prior !== request?.id) {
      const left = state?.requests[prior];
      const mine = getThreadComposer(threadId).responding?.requestId === prior;
      // The last answer's word belongs to that request's card: never carry it under the next one.
      patchComposer(threadId, {
        responding: null,
        verdict: null,
        ...(!mine && left && left.status !== "pending" ? { notice: "Answered elsewhere." } : {}),
      });
    }
  }, [request?.id]);

  // ── Desktop drag and drop ──
  useDropUpload({
    enabled: layout === "desktop" && paneId !== "" && !readOnly && thread?.shelf !== "archived",
    onFiles: (files) => addAttachments(threadId, paneId, files),
  });

  // ── Slash menu ──
  const query = editing ? null : slashQuery(text);
  const slashCatalog = useMemo(() => commandsFor(thread?.harness, operatorCommands), [thread?.harness, operatorCommands]);
  const commandItems = useMemo(() => toCommandItems(slashCatalog), [slashCatalog]);
  const menuItems = useMemo(
    () => (query === null ? [] : searchSlashCommandItems(commandItems, query)),
    [commandItems, query],
  );
  const menuOpen = query !== null && !menuDismissed && commandItems.length > 0;
  const activeId = menuOpen ? (menuItems.some((i) => i.id === activeItemId) ? activeItemId : (menuItems[0]?.id ?? null)) : null;

  // ── Actions ──

  async function send(message: string, alternateMode: boolean, opts: { skipGuard?: boolean } = {}): Promise<void> {
    const b = resolveComposerButtons({ ...buttonInput, hasText: true, alternate: alternateMode });
    // T37: `b.requestPanel` no longer blocks a send — while the agent asks, the primary is `queue`,
    // so the message waits for the operator to answer instead of being refused.
    if (b.primary.disabled || b.primary.kind === "stop" || b.primary.kind === "update") return;
    if (!opts.skipGuard) {
      const reason = isDestructiveInput(message);
      if (reason && armed !== reason) {
        setArmed(reason);
        return;
      }
    }
    setArmed(null);
    const chips = await settleUploads(threadId);
    if (chips.some((c) => c.status === "failed")) {
      patchComposer(threadId, { error: { text: "Retry or remove the failed upload first." } });
      return;
    }
    const mode = b.primary.kind === "send" ? "start" : b.primary.kind;
    const ok = await dispatchMessage({ threadId, text: message, attachments: readyAttachments(chips), mode });
    if (ok && opts.skipGuard === undefined) {
      if (textRef.current === message) setText("", false);
      else saveDraft(threadId, textRef.current);
    }
  }

  async function submit(alternateMode: boolean): Promise<void> {
    if (buttons.primary.kind === "stop") {
      void interruptRun(threadId);
      return;
    }
    if (editing) {
      if (textRef.current.trim() === "") return;
      if (await saveQueuedEdit(threadId, textRef.current)) setText(endQueuedEdit(threadId));
      return;
    }
    if (textRef.current.trim() === "" && readyAttachments(composer.attachments).length === 0 && !uploading) return;
    await send(textRef.current, alternateMode);
  }

  function cancelEdit(): void {
    setText(endQueuedEdit(threadId));
  }

  function editQueued(row: QueuedMessage): void {
    startQueuedEdit(threadId, row, textRef.current);
    setText(row.text, false);
    boxRef.current?.focus();
  }

  // ── Keybinding table (T13): the composer's commands. The table decides which key means what. ──
  useShortcutHandler("composer.sendAlternate", () => {
    // Mod+Enter while the agent works: in Enter-sends mode it sends the other follow-up; in
    // Mod+Enter-sends mode it is the plain send (Mod+Alt+Enter is the other one there).
    void submit(enterMode === "enter");
  });
  useShortcutHandler("thread.editQueuedMessage", (event) => {
    const el = boxRef.current;
    if (!el || !event || !wantsEditNewest(event, textRef.current, el.selectionStart ?? 0)) return false;
    return queueRef.current?.editLatest() ?? false;
  });
  useShortcutHandler("thread.steerQueuedMessage", () => queueRef.current?.steerNext() ?? false);

  function pickCommand(item: ComposerCommandItem): void {
    const cmd = item.command;
    if (cmd.takesArg) {
      setText(`${cmd.command} `);
      setMenuDismissed(true);
      boxRef.current?.focus();
      return;
    }
    if (cmd.dangerous && armedCommand !== item.id) {
      setArmedCommand(item.id);
      return;
    }
    setArmedCommand(null);
    setMenuDismissed(true);
    void send(cmd.command, false, { skipGuard: true }).then(() => {
      // The command went as its own message; the box held only its prefix.
      if (slashQuery(textRef.current) !== null) setText("");
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    const native = e.nativeEvent;
    if (menuOpen && !native.isComposing) {
      const index = menuItems.findIndex((i) => i.id === activeId);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (menuItems.length === 0) return;
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActiveItemId(menuItems[(index + step + menuItems.length) % menuItems.length]!.id);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        const item = menuItems[index];
        if (item) {
          e.preventDefault();
          pickCommand(item);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === "Escape" && editing) {
      e.preventDefault();
      cancelEdit();
      return;
    }
    // A key the table binds here was the global handler's to take; when it declined, the key does
    // nothing extra (and a chord that would type a newline types nothing).
    const bound = resolveShortcutCommand(native, KEYBINDINGS, { context: currentShortcutContext() });
    if (bound !== null) {
      if (bound !== "thread.editQueuedMessage") e.preventDefault();
      return;
    }
    const keyLike = {
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      isComposing: native.isComposing,
      keyCode: native.keyCode,
    };
    // Plain Enter / Shift+Enter (and the chords the table leaves to the Enter mode). Mod+Shift+Enter
    // never gets here: it is the table's thread.steerQueuedMessage.
    const action = resolveEnterAction(keyLike, enterMode);
    if (action === "submit" || action === "submit-alternate") {
      e.preventDefault();
      void submit(action === "submit-alternate");
    }
  }

  function onChange(e: ChangeEvent<HTMLTextAreaElement>): void {
    setText(e.target.value);
    setMenuDismissed(false);
    if (armed) setArmed(null);
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0 && paneId) {
      e.preventDefault();
      addAttachments(threadId, paneId, files);
      return;
    }
    const pasted = e.clipboardData?.getData("text") ?? "";
    if (isLargePaste(pasted)) {
      e.preventDefault();
      setPendingPaste(pasted);
    }
  }

  function insertAtCaret(insert: string): void {
    const el = boxRef.current;
    const current = textRef.current;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    setText((current.slice(0, start) + insert + current.slice(end)).slice(0, MAX_COMPOSER_CHARS));
  }

  async function retry(): Promise<void> {
    const failed = composer.error?.retry;
    if (!failed) return;
    const b = resolveComposerButtons({ ...buttonInput, hasText: true, alternate: false });
    if (b.primary.disabled || b.primary.kind === "stop" || b.primary.kind === "update") return;
    const mode = b.primary.kind === "send" ? "start" : b.primary.kind;
    const ok = await dispatchMessage({ threadId, text: failed.text, attachments: failed.attachments, mode });
    if (ok && textRef.current === failed.text) setText("", false);
  }

  // ── Context window (T3's ContextWindowMeter): Compact sends the harness's `/compact` as a message ──
  const contextUsage = useMemo(() => contextWindowSnapshot(thread?.contextUsage), [thread?.contextUsage]);
  const compactCommand = manualCompactionCommand(slashCatalog);
  const compactButtons = resolveComposerButtons({ ...buttonInput, hasText: true, editing: false, uploading: false, alternate: false });
  const compactBlocked =
    thread?.status === "working"
      ? "The agent is working. Compact when it stops."
      : compactButtons.primary.kind !== "send" || compactButtons.primary.disabled
        ? (compactButtons.primary.reason ?? "Compact is not available now.")
        : null;
  async function compact(): Promise<void> {
    if (!compactCommand || compactBlocked) return;
    // Its own message: the box's draft and staged files stay for the next send.
    const keep = getThreadComposer(threadId).attachments;
    const ok = await dispatchMessage({ threadId, text: compactCommand, attachments: [], mode: "start" });
    if (!ok) return;
    if (keep.length > 0) patchComposer(threadId, { attachments: keep });
    saveDraft(threadId, textRef.current);
  }

  // ── Tasks (T3's ComposerTasksBadge): the agent's newest task list ──
  const tasks = useMemo(() => (runs && items ? activeComposerTasks({ runs, items }) : null), [runs, items]);
  const hasTasks = tasks !== null;
  useEffect(() => {
    if (!hasTasks) setTasksOpen(false);
  }, [hasTasks]);

  /** The Keys dock's sender; the wheel's key slices use it too, so both send alike. */
  function sendDockKeys(keys: string[]): Promise<boolean> {
    if (!paneId) return Promise.resolve(false);
    return sendKeys(paneId, keys)
      .then((r) => r.ok)
      .catch(() => false);
  }

  // ── Banners ──
  const latestRun = useMemo(() => {
    const runs = Object.values(state?.runs ?? {});
    return runs.length > 0 ? runs.reduce((a, b) => (b.ordinal > a.ordinal ? b : a)) : null;
  }, [state?.runs]);
  // The error the latest run ended on (T3's ThreadErrorBanner / UsageLimitRecoveryBanner), dismissed per device.
  const runError = useMemo(() => (runs && items ? latestRunError({ runs, items }) : null), [runs, items]);
  const errorKey = getThreadErrorBannerKey(threadId, runError?.id ?? null);
  const banners: ComposerBannerStackItem[] = [];
  if (readOnly) banners.push({ id: "read-only", variant: "info", icon: <LockIcon />, title: "This device is read-only." });
  if (runError && errorKey) {
    if (!isThreadErrorBannerDismissed(errorKey, dismissedErrors)) {
      const onDismiss = () => dismissThreadErrorBanner(errorKey);
      banners.push(
        runError.failure.class === "usage_limit"
          ? usageLimitRecoveryBannerItem({
              bannerKey: errorKey,
              resetAt: runError.failure.resetAt ?? null,
              stoppedAt: latestRun?.completedAt ?? runError.createdAt,
              snoozedUntil: thread?.shelf === "snoozed" ? (thread.snoozedUntil ?? null) : null,
              disabled: readOnly || linkLost,
              onSnooze: (until) => performThreadCommand({ type: "thread.snooze", threadId, until }),
              onDismiss,
            })
          : threadErrorBannerItem({
              bannerKey: errorKey,
              title: runError.title?.trim() || "The last run failed",
              message: runError.failure.message,
              errorClass: runError.failure.class,
              onDismiss,
            }),
      );
    }
  } else if (latestRun?.status === "failed" && dismissedRun !== latestRun.id) {
    banners.push({
      id: "run-failed",
      variant: "warning",
      icon: <TriangleAlertIcon />,
      title: "The last run failed.",
      onDismiss: () => setDismissedRun(latestRun.id),
    });
  }
  if (composer.notice) {
    banners.push({
      id: "notice",
      variant: "info",
      icon: <TriangleAlertIcon />,
      title: composer.notice,
      onDismiss: () => patchComposer(threadId, { notice: null }),
    });
  }
  if (composer.error) {
    banners.push({
      id: "error",
      variant: "error",
      icon: <TriangleAlertIcon />,
      title: composer.error.text,
      actions: composer.error.retry ? (
        <Button size="xs" variant="outline" disabled={linkLost || composer.busy !== null} onClick={() => void retry()}>
          <RotateCwIcon className="size-3" aria-hidden="true" />
          Retry
        </Button>
      ) : undefined,
      onDismiss: () => patchComposer(threadId, { error: null }),
    });
  }
  if (herdr === "disconnected") {
    banners.push({ id: "herdr", variant: "warning", icon: <ServerOffIcon />, title: "Herdr is not reachable on the host." });
  }
  if (linkLost) {
    banners.push({ id: "link", variant: "error", priority: "urgent", icon: <WifiOffIcon />, title: "Not connected. Sending is paused." });
  }
  // Phase 5.3: the bridge lifted the post-restart hold by itself once the pane rested. The queue is
  // no longer paused, so this says what happened rather than offering a Resume; Dismiss clears it.
  if (state?.queueAutoResume) {
    banners.push({
      id: "queue-auto-resume",
      variant: "info",
      icon: <ListOrderedIcon />,
      title: queueAutoResumeText(state.queueAutoResume.count),
      onDismiss: () => dismissQueueAutoResume(threadId),
    });
  }

  const statusText = armed ? `Destructive: ${armed}. Tap Confirm to send.` : (buttons.primary.reason ?? "");

  const announce = request
    ? request.kind === "password"
      ? "The agent is asking for a password."
      : `The agent is asking: ${request.prompt.split("\n", 1)[0] ?? ""}`
    : "";

  return (
    <div
      data-region="composer"
      data-typing={typing || undefined}
      className="border-t bg-background px-3 pt-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] data-typing:pb-2"
    >
      <div aria-live="assertive" className="sr-only">
        {announce}
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
        {statusLine ? (
          <ThreadStatusLine
            icon={statusLine.kind === "snoozed" ? <AlarmClockIcon aria-hidden="true" /> : <CircleCheckIcon aria-hidden="true" />}
            label={statusLine.label}
            actionLabel={statusLine.actionLabel}
            actionDisabled={readOnly || linkLost}
            onAction={() => void performThreadCommand({ type: statusLine.command, threadId })}
          />
        ) : null}
        <ComposerBannerStack items={banners} />
        <QueuedRunsControl
          ref={queueRef}
          threadId={threadId}
          queue={queue}
          canSteer={canSteerQueued}
          editingId={editing?.id ?? null}
          onEditQueued={editQueued}
          onCancelEdit={cancelEdit}
        />
        {tasks ? (
          <>
            <ComposerTasksBadge expanded={tasksOpen} onToggle={() => setTasksOpen((open) => !open)} progress={tasks.progress} steps={tasks.steps} />
            <ComposerTasksSheet open={tasksOpen} onClose={() => setTasksOpen(false)} progress={tasks.progress} steps={tasks.steps} />
          </>
        ) : null}
        {request ? (
          // A tall card (a long menu, a preview) scrolls inside itself, so its buttons stay on screen and
          // the timeline keeps a strip above it.
          <section
            role="region"
            aria-label="The agent is asking"
            data-request-panel="true"
            className="max-h-[min(40rem,70dvh)] overflow-y-auto overscroll-contain"
          >
            {isWhistlrDecision(request) ? (
              // T19: a draftr decision goes through `whistlr reply`, never keys or runtime-request.respond.
              <ComposerDecisionPanel
                request={request}
                pendingCount={requests.length}
                respondingIndex={composer.responding?.requestId === request.id ? composer.responding.optionIndex : null}
                verdict={composer.verdict}
                disabled={readOnly || linkLost || paneId === ""}
                firstOptionRef={firstOptionRef}
                onRespond={(index) => void replyToDecision(threadId, paneId, request, index)}
              />
            ) : request.kind === "question" ? (
              <ComposerPendingUserInputPanel
                request={request}
                pendingCount={requests.length}
                respondingIndex={composer.responding?.requestId === request.id ? composer.responding.optionIndex : null}
                verdict={composer.verdict}
                disabled={readOnly || linkLost}
                firstOptionRef={firstOptionRef}
                onRespond={(index) => void respondToRequest(threadId, request.id, index)}
              />
            ) : (
              <ComposerPendingApprovalPanel
                request={request}
                pendingCount={requests.length}
                respondingIndex={composer.responding?.requestId === request.id ? composer.responding.optionIndex : null}
                verdict={composer.verdict}
                disabled={readOnly || linkLost}
                firstOptionRef={firstOptionRef}
                onRespond={(index) => void respondToRequest(threadId, request.id, index)}
              />
            )}
          </section>
        ) : null}
        {/* T37: the box stays under the request panel, so the next message can be written and queued. */}
        <>
            {keysOpen && layout === "phone" && paneId ? (
              <div data-keys-dock="true" className="rounded-xl border bg-card p-1.5">
                <NavTray
                  onSend={sendDockKeys}
                  presets={ctrlPresetsFor(thread?.harness, operatorKeys)}
                  disabled={readOnly || linkLost}
                />
              </div>
            ) : null}
            {menuOpen ? (
              <ComposerCommandMenu
                listId={listId}
                items={menuItems}
                activeItemId={activeId}
                armedItemId={armedCommand}
                onHighlightedItemChange={setActiveItemId}
                onSelect={pickCommand}
              />
            ) : null}
            {confirmMode !== null ? (
              <div
                role="alertdialog"
                aria-label="Confirm the permission mode"
                className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-error-surface px-3 py-2 text-sm"
              >
                <ShieldAlertIcon className="size-4 shrink-0 text-destructive" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {modeLabel(confirmMode)}: the agent runs every tool without asking you first.
                  {modeBlocked ? <span className="block text-xs text-muted-foreground">{modeBlocked}</span> : null}
                </span>
                <Button size="sm" variant="destructive" className="pointer-coarse:min-h-11" disabled={modeBlocked !== null} onClick={confirmDestructiveMode}>
                  Switch to {modeLabel(confirmMode)}
                </Button>
                <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={() => setConfirmMode(null)}>
                  Cancel
                </Button>
              </div>
            ) : null}
            {pendingPaste !== null ? (
              <div role="alertdialog" aria-label="Large paste" className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm">
                <span className="flex-1">
                  That paste is {Math.round(pendingPaste.length / 1024)} KB. Attach as a file instead?
                </span>
                <Button
                  size="xs"
                  onClick={() => {
                    if (paneId) addAttachments(threadId, paneId, [new File([pendingPaste], `paste-${Date.now()}.txt`, { type: "text/plain" })]);
                    setPendingPaste(null);
                  }}
                >
                  Attach as file
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    insertAtCaret(pendingPaste);
                    setPendingPaste(null);
                  }}
                >
                  Paste anyway
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setPendingPaste(null)}>
                  Cancel
                </Button>
              </div>
            ) : null}
            {editing ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1 rounded-full border bg-accent px-2 py-0.5 text-foreground">
                  <PencilIcon className="size-3" aria-hidden="true" />
                  Editing queued message
                </span>
                <Button size="icon-xs" variant="ghost" aria-label="Discard the edit" onClick={cancelEdit}>
                  <XIcon />
                </Button>
              </div>
            ) : null}
            <ReviewCommentsBar threadId={threadId} text={text} />
            {composer.attachments.length > 0 ? (
              <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
                {composer.attachments.map((chip) => (
                  <AttachmentChipView
                    key={chip.id}
                    chip={chip}
                    onOpen={chip.image ? () => openImage(chip.id) : undefined}
                    onRetry={() => retryAttachment(threadId, paneId, chip.id)}
                    onRemove={() => removeAttachment(threadId, chip.id)}
                  />
                ))}
              </ul>
            ) : null}
            <div className="rounded-2xl border border-input bg-card focus-within:border-ring">
              <textarea
                ref={boxRef}
                aria-label="Message"
                data-composer-input=""
                aria-autocomplete="list"
                aria-controls={menuOpen ? listId : undefined}
                aria-activedescendant={menuOpen && activeId ? composerSuggestionOptionId(listId, activeId) : undefined}
                rows={1}
                value={text}
                maxLength={MAX_COMPOSER_CHARS}
                disabled={readOnly || thread?.shelf === "archived"}
                autoCapitalize="sentences"
                enterKeyHint={enterMode === "enter" ? "send" : "enter"}
                placeholder={editing ? "Edit the queued message" : "Message the agent"}
                className="block max-h-[40dvh] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base text-foreground outline-none placeholder:text-placeholder disabled:opacity-64 pointer-fine:sm:text-sm"
                onChange={onChange}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onFocus={() => {
                  boxFocused.current = true;
                  if (coarse) setTyping(true);
                }}
                onBlur={() => {
                  boxFocused.current = false;
                  setTyping(false);
                }}
              />
              <ComposerPromptLengthValidation message={lengthMessage} />
              {statusText && layout === "phone" ? (
                // Phone: the toolbar has no room left for it, so the hint gets its own line.
                <p className="px-3 pb-0.5 text-xs text-muted-foreground" aria-live="polite" data-composer-status="">
                  {statusText}
                </p>
              ) : null}
              <div className="flex items-center gap-1 px-1.5 pb-1.5">
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept={ATTACH_ACCEPT}
                  className="hidden"
                  data-testid="attach-input"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length > 0 && paneId) addAttachments(threadId, paneId, files);
                    e.target.value = "";
                  }}
                />
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label="Attach a file"
                  disabled={readOnly || !paneId}
                  onClick={() => fileRef.current?.click()}
                >
                  <PaperclipIcon />
                </Button>
                {layout === "phone" ? (
                  <Button
                    size="icon-sm"
                    variant={keysOpen ? "outline" : "ghost-muted"}
                    aria-label="Keys"
                    aria-pressed={keysOpen}
                    disabled={!paneId}
                    onClick={() => setKeysOpen((open) => !open)}
                  >
                    <KeyboardIcon />
                  </Button>
                ) : null}
                {modeOptions ? (
                  <CompactComposerControlsMenu
                    runtimeMode={thread?.permissionMode}
                    runtimeModeOptions={modeOptions}
                    blockedReason={composer.busy === "mode" ? null : modeBlocked}
                    switching={composer.busy === "mode"}
                    size={layout === "phone" ? "xs" : "sm"}
                    onRuntimeModeChange={pickMode}
                  />
                ) : null}
                {contextUsage ? (
                  <ContextWindowMeter
                    usage={contextUsage}
                    onCompact={compactCommand ? () => void compact() : undefined}
                    compactDisabled={compactBlocked !== null}
                    compactDisabledReason={compactBlocked}
                  />
                ) : null}
                <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground" aria-live={layout === "phone" ? undefined : "polite"}>
                  {layout === "phone" ? "" : statusText}
                </span>
                {layout === "phone" ? (
                  <GestureWheel
                    slices={wheelSlicesFor(operatorWheel, wheelPicks, ctrlPresetsFor(thread?.harness, operatorKeys))}
                    onKeys={sendDockKeys}
                    onType={() => {
                      // Type: the Terminal tab (or the CLI view), with direct typing armed (T13).
                      useRightPanelStore.getState().requestDirectTyping(threadId);
                      openThreadTerminal(threadId);
                    }}
                    typeActive={false}
                    onTap={() => setKeysOpen((open) => !open)}
                    disabled={readOnly || linkLost || !paneId || thread?.shelf === "archived"}
                    busy={composer.busy === "send"}
                  />
                ) : null}
                <ComposerPrimaryActions
                  buttons={buttons}
                  confirmArmed={armed !== null}
                  interrupting={composer.busy === "interrupt"}
                  followUp={followUp}
                  canSteer={canSteer}
                  onSubmit={(alt) => void submit(alt)}
                  onInterrupt={() => void interruptRun(threadId)}
                />
              </div>
            </div>
        </>
      </div>
      {expanded ? <ExpandedImageDialog preview={expanded} onClose={closeImage} /> : null}
    </div>
  );
}

function AttachmentChipView({
  chip,
  onOpen,
  onRetry,
  onRemove,
}: {
  chip: AttachmentChip;
  /** An image chip: a thumbnail that opens the viewer. */
  onOpen?: (() => void) | undefined;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const file = chip.image ? attachmentFile(chip.id) : undefined;
  return (
    <li
      data-attachment-status={chip.status}
      className={cn(
        "flex max-w-full items-center gap-1 rounded-lg border bg-card py-0.5 ps-2 pe-0.5 text-xs",
        chip.status === "failed" && "border-destructive/40 bg-error-surface text-destructive",
      )}
    >
      {file && onOpen ? (
        <button
          type="button"
          aria-label={`View ${chip.name}`}
          data-attachment-thumbnail=""
          className="relative -my-0.5 -ms-1.5 size-8 shrink-0 overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5"
          onClick={onOpen}
        >
          <ComposerImageThumbnail
            file={file}
            alt=""
            className="size-full object-cover"
            fallback={<ImageIcon className="m-auto size-4 text-muted-foreground" aria-hidden="true" />}
          />
        </button>
      ) : null}
      {chip.status === "uploading" ? <Loader2Icon className="size-3 animate-spin" aria-label="Uploading" /> : null}
      <span className="min-w-0 truncate" title={chip.error ?? chip.name}>
        {chip.name}
        {/* A title is hover-only; a phone needs the reason on the chip. */}
        {chip.status === "failed" && chip.error ? <span className="ms-1 opacity-80">· {chip.error}</span> : null}
      </span>
      {chip.status === "failed" ? (
        <Button size="xs" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
      <Button size="icon-xs" variant="ghost" aria-label={`Remove ${chip.name}`} onClick={onRemove}>
        <XIcon />
      </Button>
    </li>
  );
}
