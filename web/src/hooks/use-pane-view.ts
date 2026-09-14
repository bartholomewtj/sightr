import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useRevalidator } from "react-router";
import { type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { useStableTerminalDraft } from "@/hooks/use-terminal-draft";
import { setStatus } from "@/lib/status";
import { parseLines } from "@/lib/blocks";
import { hasParsedDialog, noteDialogPresence } from "@/lib/dialog-presence";
import { adapterFor, buildBlocks } from "@/lib/harness";
import { onFindOpenRequest } from "@/lib/find-request";
import { canGrowRequestedLines, growRequestedLines } from "@/lib/loaders";
import {
  useInlineHistory,
  INLINE_GROW_THRESHOLD,
} from "@/hooks/use-inline-history";
import { useDesktop } from "@/lib/desktop";
import type { AgentView } from "@/lib/types";
import type { PromptBlockAction } from "@/components/prompt-select-block";
import type { PreviewBlockAction } from "@/components/preview-select-block";
import type { MenuBlockAction } from "@/components/menu-block";
import type {
  PromptModel,
  WizardModel,
  PreviewSelectModel,
  MultiSelectModel,
  MenuModel,
} from "@/lib/blocks";
import type { MultiSelectIntent } from "@/lib/actions";
import { submitPromptFeedback, submitPromptOption } from "@/lib/actions";
import { submitWizardKeys } from "@/lib/actions";
import {
  submitPreviewKeys,
  submitPreviewNote,
  submitPreviewOption,
} from "@/lib/actions";
import { submitMultiSelectIntent } from "@/lib/actions";
import { submitMenuKeys } from "@/lib/actions";
import {
  awaitDialogSettled,
  type Compare,
  type PaneSnapshot,
} from "@/lib/dialog-guard";
import type { DialogKind, DialogModels } from "@/lib/harness/dialog-contract";
export interface PaneViewArgs {
  paneId: string;
  agent: AgentView | undefined;
  text: string;
  requestedLines: number;
  revision: number;
  readOnly: boolean;
  stripChrome: boolean;
  tapToFocus: boolean;
  desktop: boolean;
  typing: ReturnType<typeof useDesktop>["typing"];
}
export function usePaneView(args: PaneViewArgs) {
  const {
    paneId,
    agent,
    text,
    requestedLines,
    revision,
    readOnly,
    stripChrome,
    tapToFocus,
    desktop,
    typing,
  } = args;
  const revalidator = useRevalidator();
  const listRef = useRef<ChatMessageListHandle>(null);
  const composerRef = useRef<any>(null);
  const [armed, setArmed] = useState(false);

  // Mirror freeze: at the bottom we follow live output; the moment you scroll up to read backscroll
  // we hold the text steady (no reflow / no re-pin) until you jump back to latest — so a long
  // message stays put long enough to read instead of sliding out of the rolling window.
  //
  // The frozen snapshot is a {text, revision} PAIR captured at the same instant: the prompt-select
  // race guard must check a tap against the revision of what the user is LOOKING AT. The live
  // `revision` prop keeps advancing with background polls while the mirror is frozen — comparing
  // against it would blind the guard to drift that happened before the freeze (live-vs-live always
  // matches). While following, the frozen pair IS the live pair by definition.
  const [following, setFollowing] = useState(true);
  const [shown, setShown] = useState({ text, revision });
  const liveRef = useRef({ text, revision });
  liveRef.current = { text, revision };
  const adoptedOver = useRef<PaneSnapshot | null>(null);

  const adoptSnapshot = useCallback((snap: PaneSnapshot) => {
    adoptedOver.current = liveRef.current;
    setShown(snap);
  }, []);

  useEffect(() => {
    if (!following) return;
    if (
      adoptedOver.current &&
      text === adoptedOver.current.text &&
      revision === adoptedOver.current.revision
    ) {
      return;
    }
    adoptedOver.current = null;
    // Functional update that returns the previous object when nothing changed keeps React's
    // Object.is bailout — no re-render per poll while the pane is quiet.
    setShown((prev) =>
      prev.text === text && prev.revision === revision
        ? prev
        : { text, revision },
    );
  }, [text, revision, following]);
  const display = shown.text;
  const hasNew = !following && display !== text;

  // The agent's own statusline (model · ctx% · cwd · branch · tokens · permission mode) is stripped
  // off the mirror by stripChrome so it doesn't duplicate the composer — but it carries real context
  // (the branch, most notably), so we re-surface it as app chrome just above the composer, where it
  // sat in the TUI. ALL its rows: a configured statusline is routinely 2–3 rows tall, and we used to
  // surface only the first, silently losing the rest. Routed through the SAME adapter (adapterFor)
  // whose buildBlocks strips the chrome, so the two can't drift; empty when there's no adapter for
  // the agent, a menu is up, or no box at the tail, in which case the strip is hidden. A second parse
  // of `display`, but memoised on it, so it only recomputes when the buffer content changes — off the
  // render hot path.
  const parsedDisplay = useMemo(() => {
    const lines = parseLines(display);
    const blocks = buildBlocks(lines, { agent: agent?.agent });
    const adapter = adapterFor(agent?.agent);
    return {
      lines,
      blocks,
      statusLines: stripChrome
        ? (adapter?.extractStatusLines(lines) ?? [])
        : [],
      rawTerminalDraft: stripChrome
        ? (adapter?.extractInputDraft(lines) ?? null)
        : null,
      needsDump: adapter?.needsDump?.(lines) === true,
    };
  }, [display, agent?.agent, stripChrome]);
  const { lines, blocks, statusLines, rawTerminalDraft, needsDump } = parsedDisplay;

  // A user draft stranded on the input box's "❯" line — a message queued while the agent was busy
  // then recalled, which persists across turns. stripChrome peels the box off the mirror so it goes
  // invisible, and (worse) pane.send_text appends to it, corrupting the next send. We surface it to
  // the composer as a read-only preview the user can deliberately Take over — the input is otherwise
  // exclusively phone-owned. Same parse source + same adapter as the statusline, so the two can't
  // drift; null when raw-terminal is on, there's no adapter, no box is at the tail, or the line is empty.
  // Is a dialog (prompt/wizard/preview/multi-select) on screen right now? Any non-raw block means
  // the TUI's keyboard belongs to it, so the composer must refuse a free-text send: the text would
  // be swallowed and the submit key would answer the dialog (collie#34). Same parse source and adapter as
  // the two probes above, so the three can't drift. This is the zero-latency fail-fast; the
  // load-bearing protection is actions's verify-before-submit, which also covers a dialog that
  // appears after this render.
  const currentDialog = [...blocks].reverse().find((b) => b.kind !== "raw");
  const dialogPresent = currentDialog !== undefined;
  // #372: tell the herd whether a parsed ask card is on this pane, so bucketOf can say Needs you even
  // while Herdr reports working/done. Same `blocks` as the card itself, so the two can't disagree. Only
  // while following: a frozen mirror (scrolled back / find open) is not the live screen.
  const askOnScreen = hasParsedDialog(blocks);
  const agentStatus = agent?.status;
  const agentActiveAt = agent?.lastActiveAt;
  const revalidateRef = useRef(revalidator);
  revalidateRef.current = revalidator;
  useEffect(() => {
    if (!following) return;
    const changed = noteDialogPresence(
      paneId,
      askOnScreen,
      agentStatus === undefined ? undefined : { status: agentStatus, lastActiveAt: agentActiveAt },
    );
    // Re-run the root loader once on an edge, so the inbox/dots pick it up now, not a poll later.
    if (changed && revalidateRef.current.state === "idle") revalidateRef.current.revalidate();
  }, [paneId, askOnScreen, agentStatus, agentActiveAt, following]);
  const promptBlock =
    currentDialog?.kind === "prompt-select" ? currentDialog : undefined;

  // Both are threaded to the composer: the RAW value (live) plus a stabilised one. extractInputDraft
  // is stateless, so it can't distinguish a stranded draft from the ~350ms flash where our OWN
  // just-sent reply sits on the "❯" line waiting for the bridge's pending Enter. The stabilised value
  // (same text must persist ~1.5s) gates the preview's APPEARANCE so that flash never surfaces (the
  // composer adds a second guard: it suppresses a draft matching what it just sent); once shown, the
  // preview's text tracks the RAW line live, so host typing streams in without ever touching the input.
  const terminalDraft = useStableTerminalDraft(rawTerminalDraft);

  // Find-in-output: search the already-fetched buffer. The bar takes over the header while open;
  // AnsiOutput highlights matches and reports the count back here; prev/next scrolls the focused
  // match into view. Opening freezes the tail so matches don't shift under you as polls land.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  useEffect(() => {
    setCurrentMatch(0); // a fresh query starts from the first match
  }, [findQuery]);
  const handleMatchCount = useCallback((n: number) => {
    setMatchCount(n);
    setCurrentMatch((c) => (n === 0 ? 0 : Math.min(c, n - 1)));
  }, []);
  function gotoMatch(delta: number) {
    if (matchCount === 0) return;
    setFollowing(false); // freeze the tail so scroll-into-view doesn't fight the live re-pin
    setCurrentMatch((c) => (c + delta + matchCount) % matchCount);
  }
  function openFind() {
    setFollowing(false); // freeze the buffer so the search target is stable while you type
    setFindOpen(true);
  }
  useEffect(() => onFindOpenRequest(openFind), []);
  function closeFind() {
    setFindOpen(false);
    setFindQuery("");
  }

  // `historyAvailable`: the pane reported an agent session, so a transcript exists to stack above
  // the live tail. `moreScrollback`: Herdr says this pane can still yield lines beyond the window
  // we've asked for, AND we're under the cap Herdr's own read clamp imposes. `readableLines` is
  // undefined on an older bridge/Herdr; treat that as "no idea" and stay hidden rather than offer a
  // tap that fetches nothing. An agent session wins over Load older — alt-screen has no ring.
  const historyAvailable = Boolean(agent?.hasSession);
  const moreScrollback =
    agent?.readableLines !== undefined &&
    requestedLines < agent.readableLines &&
    canGrowRequestedLines(paneId);

  const getScrollElement = useCallback(
    () => listRef.current?.getScrollElement() ?? null,
    [],
  );
  const inline = useInlineHistory({
    paneId,
    enabled: historyAvailable,
    status: agent?.status,
    getScrollElement,
  });

  // Load older scrollback: raise the per-pane requested line count and refetch. The enlarged buffer
  // prepends older lines at the top, so we adopt it into the frozen display and re-anchor the scroll
  // position (measure height before, restore after) to keep the content you were reading in place.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderAnchor = useRef<{ height: number; top: number } | null>(null);
  const adoptTarget = useRef<number | null>(null); // the requestedLines a pending grow is waiting on
  const pendingRestore = useRef(false); // re-anchor scroll after the enlarged display paints
  const loadOlder = useCallback(() => {
    if (loadingOlder || !canGrowRequestedLines(paneId)) return;
    const el = listRef.current?.getScrollElement();
    olderAnchor.current = el
      ? { height: el.scrollHeight, top: el.scrollTop }
      : null;
    setLoadingOlder(true);
    setFollowing(false); // stay put in history rather than snapping to the tail
    adoptTarget.current = growRequestedLines(paneId);
    revalidator.revalidate();
  }, [loadingOlder, paneId, revalidator]);
  // Adopt the enlarged buffer into the frozen display once the *grown* fetch lands — keyed on the
  // requested line count so a stale in-flight poll (still on the old window) can't adopt early.
  // Adopts the whole {text, revision} pair (props from the same loader result) so the frozen
  // snapshot stays coherent for the race guard.
  useEffect(() => {
    const target = adoptTarget.current;
    if (target === null || requestedLines < target) return;
    adoptTarget.current = null;
    setLoadingOlder(false);
    if (text === display) {
      olderAnchor.current = null; // nothing new arrived (buffer shorter than the window)
      return;
    }
    pendingRestore.current = true;
    adoptedOver.current = null;
    setShown({ text, revision });
  }, [requestedLines, text, revision, display]);
  // After the enlarged display paints, keep the previously-visible content anchored (content grew at
  // the top, so push scrollTop down by the height delta).
  useLayoutEffect(() => {
    if (!pendingRestore.current) return;
    pendingRestore.current = false;
    const anchor = olderAnchor.current;
    const el = listRef.current?.getScrollElement();
    if (anchor && el)
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    olderAnchor.current = null;
  }, [display]);

  // Swipe toward the top pages older transcript turns. Shells still use the Load older tap —
  // each grow is a bigger Herdr read, and auto-firing those from a restore would cascade.
  useEffect(() => {
    const el = listRef.current?.getScrollElement();
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop >= INLINE_GROW_THRESHOLD) return;
      if (historyAvailable) inline.growUpward();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [historyAvailable, inline.growUpward]);

  // Opening / switching into this pane must land on the live tail. Stickiness usually handles it,
  // but the first flex layout + AnsiOutput paint can race; pin once after mount so a tab/pane open
  // never strands you at the oldest scrollback.
  useLayoutEffect(() => {
    listRef.current?.scrollToBottom();
  }, []);

  // Prefetch inserts turns ABOVE the live tail. If the mirror didn't overflow, scrollTop was 0
  // and stays 0, so without a re-pin the reader lands on the oldest turn. Stay on the tail
  // while following; the hook re-anchors once they've scrolled up.
  useLayoutEffect(() => {
    if (following && inline.entries.length > 0)
      listRef.current?.scrollToBottom();
  }, [inline.entries, following]);

  // After a successful send, snap the mirror back to the live tail so the reply's result is visible.
  // A context wipe (`/clear`, or `/new` on agents that spell it that way) also drops the inline
  // history right away — those turns belong to the session that just ended.
  const onSent = (sent: string) => {
    if (/^\/(clear|new)(\s|$)/.test(sent.trim())) inline.reset();
    setFollowing(true);
    revalidator.revalidate();
    listRef.current?.scrollToBottom();
  };

  const settling = useRef(false);
  const settleAfterSend = useCallback(
    async <K extends DialogKind>(
      kind: K,
      model: DialogModels[K],
      detectedRevision: number,
      compare: Compare = "commits",
    ): Promise<void> => {
      settling.current = true;
      try {
        const out = await awaitDialogSettled(
          {
            paneId,
            requestedLines,
            detectedRevision,
            agent: agent?.agent,
            kind,
            model,
          },
          compare,
        );
        setFollowing(true);
        if (out.status === "settled") adoptSnapshot(out.snapshot);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } finally {
        settling.current = false;
      }
    },
    [paneId, requestedLines, agent?.agent, adoptSnapshot, revalidator],
  );

  // Tap a prompt-select option. This can type into a real terminal, so it runs the revision-based
  // race guard first (fresh fetch → revision + re-derived-menu equality); only a clean match sends
  // the option's keys. The guard checks against the FROZEN pair's revision — the menu the user
  // tapped was derived from `shown.text`, so `shown.revision` is the revision of what they saw
  // (the live `revision` prop may have advanced under a frozen mirror). A stale tap is discarded
  // with a "menu changed" notice and a revalidate; a clean send snaps back to the tail so the
  // result is visible. After a send, the lock is held until a fresh read shows the tap's effect (#368).
  // The composer stays live for the free-text rows we don't render as buttons.
  const handlePromptAction = useCallback(
    async (action: PromptBlockAction, prompt: PromptModel) => {
      if (readOnly) {
        setStatus("Read-only — device not authorised", "error");
        return false;
      }
      if (settling.current) return false;
      const base = {
        paneId,
        requestedLines,
        detectedRevision: shown.revision,
        agent: agent?.agent,
        prompt,
      };
      // Two recipes behind one block: a single guarded keystroke for an option, and the plan
      // dialog's multi-step feedback sequence (digit → verify focus → type → Enter, which denies the
      // plan and hands the agent the text — see lib/actions.ts).
      const result =
        action.kind === "option"
          ? await submitPromptOption({ ...base, option: action.option })
          : await submitPromptFeedback({ ...base, text: action.text });
      if (result.status === "sent") {
        setStatus(
          action.kind === "feedback" ? "Feedback sent" : "Sent",
          "success",
        );
        await settleAfterSend(
          "prompt-select",
          prompt,
          shown.revision,
          action.kind === "feedback" ? "identity" : "commits",
        );
      } else if (result.status === "changed") {
        setStatus("Menu changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
      }
      // Reported back so the block can keep a refused feedback draft on screen rather than discard
      // what someone just thumb-typed. Option taps ignore it.
      return result.status === "sent";
    },
    [
      readOnly,
      paneId,
      requestedLines,
      shown.revision,
      agent?.agent,
      settleAfterSend,
      revalidator,
    ],
  );

  // Tap a wizard control (an option digit, step navigation, or the review step's submit/cancel).
  // Same shape as handlePromptAction — the guard re-derives the wizard from a FRESH read and only
  // a clean match sends the single keystroke (incremental round-trip; grammar/WIZARD_NOTES.md).
  // gate: Claude's adapter is the only one that emits `wizard` (buildBlocks routes through the pane's
  // adapter — see harness/registry.ts), so this handler cannot fire for any other agent.
  const handleWizardAction = useCallback(
    async (keys: string[], wizard: WizardModel) => {
      if (readOnly) {
        setStatus("Read-only — device not authorised", "error");
        return;
      }
      if (settling.current) return;
      const result = await submitWizardKeys({
        paneId,
        requestedLines,
        detectedRevision: shown.revision,
        agent: agent?.agent,
        wizard,
        keys,
      });
      if (result.status === "sent") {
        setStatus("Sent", "success");
        await settleAfterSend("wizard", wizard, shown.revision, "commits");
      } else if (result.status === "changed") {
        setStatus("Wizard changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
      }
    },
    [
      readOnly,
      paneId,
      requestedLines,
      shown.revision,
      agent?.agent,
      settleAfterSend,
      revalidator,
    ],
  );

  // Tap a preview-dialog control (an option, the note add/edit/remove, or the wizard step nav).
  // Same guard-first shape as the two handlers above, but the choreography behind an intent is
  // MULTI-step (digit→verify→Enter; n→verify→type→Escape — see lib/actions.ts and
  // grammar/NOTES_NOTES.md), so the handler dispatches on the intent kind.
  // gate: Claude's adapter is the only one that emits `preview-select` — no other registered adapter
  // lifts this kind, so this handler cannot fire for another agent.
  const handlePreviewAction = useCallback(
    async (action: PreviewBlockAction, preview: PreviewSelectModel) => {
      if (readOnly) {
        setStatus("Read-only — device not authorised", "error");
        return;
      }
      if (settling.current) return;
      const base = {
        paneId,
        requestedLines,
        detectedRevision: shown.revision,
        agent: agent?.agent,
        preview,
      };
      const result =
        action.kind === "option"
          ? await submitPreviewOption({ ...base, option: action.option })
          : action.kind === "note"
            ? await submitPreviewNote({ ...base, text: action.text })
            : await submitPreviewKeys({ ...base, keys: action.keys });
      if (result.status === "sent") {
        setStatus(
          action.kind === "note"
            ? action.text
              ? "Note saved"
              : "Note removed"
            : "Sent",
          "success",
        );
        await settleAfterSend(
          "preview-select",
          preview,
          shown.revision,
          action.kind === "option" ? "identity" : "commits",
        );
      } else if (result.status === "changed") {
        setStatus("Dialog changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
        revalidator.revalidate();
      }
    },
    [
      readOnly,
      paneId,
      requestedLines,
      shown.revision,
      agent?.agent,
      settleAfterSend,
      revalidator,
    ],
  );

  // Tap a multi-select control (toggle a checkbox, Submit, the "Chat about this" escape, or the
  // review screen's confirm/cancel). Same guard-first shape as the wizard handler — the guard
  // re-derives the dialog from a FRESH read; toggle sends one digit, Submit drives the closed-loop
  // Down→Up→verify→Enter macro (see lib/actions.ts). gate: Claude's adapter is the only
  // one that emits `multi-select`, so this handler cannot fire for another agent.
  const handleMultiSelectAction = useCallback(
    async (action: MultiSelectIntent, multi: MultiSelectModel) => {
      if (readOnly) {
        setStatus("Read-only — device not authorised", "error");
        return;
      }
      if (settling.current) return;
      const result = await submitMultiSelectIntent({
        paneId,
        requestedLines,
        detectedRevision: shown.revision,
        agent: agent?.agent,
        multi,
        intent: action,
      });
      if (result.status === "sent") {
        setStatus("Sent", "success");
        await settleAfterSend("multi-select", multi, shown.revision, "commits");
      } else if (result.status === "changed") {
        setStatus("Selection changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
      }
    },
    [
      readOnly,
      paneId,
      requestedLines,
      shown.revision,
      agent?.agent,
      settleAfterSend,
      revalidator,
    ],
  );

  // Tap a generic-menu control (a footer-named key like Enter/s/Esc, or an arrow). Same guard-first
  // shape as the handlers above; the arrow taps pass `nav`, which swaps the guard's signature check
  // for an identity-only one (moving the highlight is the tap's own effect — see lib/actions.ts).
  // gate: Claude's adapter is the only one that emits `menu` (buildBlocks routes through the pane’s
  // adapter — see harness/registry.ts), so this handler cannot fire for another agent.
  const handleMenuAction = useCallback(
    async (action: MenuBlockAction, menu: MenuModel) => {
      if (readOnly) {
        setStatus("Read-only — device not authorised", "error");
        return;
      }
      if (settling.current) return;
      const result = await submitMenuKeys({
        paneId,
        requestedLines,
        detectedRevision: shown.revision,
        agent: agent?.agent,
        menu,
        keys: action.keys,
        nav: action.nav,
      });
      if (result.status === "sent") {
        setStatus("Sent", "success");
        await settleAfterSend("menu", menu, shown.revision, "commits");
      } else if (result.status === "changed") {
        setStatus("The screen changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
      }
    },
    [
      readOnly,
      paneId,
      requestedLines,
      shown.revision,
      agent?.agent,
      settleAfterSend,
      revalidator,
    ],
  );

  // NOTE: the composer is deliberately NOT auto-focused on open/switch — that would pop the Android
  // keyboard and cover the output. You read the pane first, then tap the input to type. (Explicit
  // actions inside the composer still focus it; the mirror tap focuses it via composerRef.)

  // Switch to another thread from the sidebar or the swipe-up switcher (DetailRoute keys AgentChat
  // Tapping the terminal mirror focuses the composer so you can start typing right away. Three bails:
  //  - the operator turned "Tap to type" off (View). It is on by default and always has been — the
  //    mirror as one big "start typing" target is the fastest path from reading to replying on a
  //    phone. But the same handler makes the mirror unable to behave like a document, which is what
  //    someone expects who is trying to interact with a LINE rather than reply to it, and they read
  //    it as the tap being absorbed. Off, the mirror keeps its buttons and its links; it just stops
  //    volunteering the keyboard. (What it still cannot offer is a tappable agent-printed hyperlink:
  //    herdr's `pane.read` strips OSC 8, so the link target never reaches Sighter at all.)
  //  - the tap landed on an interactive control INSIDE the mirror — a native prompt/wizard/preview
  //    button, the Load-older button, or the note editor's own textarea. Their click bubbles up to
  //    this handler, and focusing the composer here would pop the soft keyboard on every option tap
  //    (and steal focus from the note editor). Only a tap on the raw terminal text should focus.
  //  - the user is selecting text (text selection), so copy works instead of the tap
  //    collapsing the selection and popping the keyboard.
  function focusFromMirror(e: ReactMouseEvent<HTMLDivElement>) {
    if (!desktop && !tapToFocus) return;
    const target = e.target as Element | null;
    // The `a` is what keeps a tap on an autolinked URL (components/ansi-output) from popping the
    // keyboard on top of the page it just opened. Don't trim it out of this selector.
    if (
      target?.closest?.("button, a, input, textarea, select, [role='textbox']")
    )
      return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    composerRef.current?.focusInput();
    if (desktop && typing === "direct" && !readOnly && !!agent)
      composerRef.current?.armDirect();
  }

  useEffect(() => {
    if (!desktop || !armed) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // The paste-hold Send/Discard overlay sits on top of the textarea, so it is
      // not `[data-slot=chat-input]`. Releasing here cleared the hold before click.
      if (target?.closest?.("[data-slot='chat-input'], [data-direct-strip]"))
        return;
      composerRef.current?.releaseDirect();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [desktop, armed]);

  return {
    listRef,
    composerRef,
    following,
    setFollowing,
    shown,
    display,
    hasNew,
    lines,
    blocks,
    statusLines,
    rawTerminalDraft,
    dialogPresent,
    needsDump,
    promptBlock,
    terminalDraft,
    findOpen,
    findQuery,
    setFindQuery,
    matchCount,
    currentMatch,
    handleMatchCount,
    gotoMatch,
    openFind,
    closeFind,
    historyAvailable,
    moreScrollback,
    inline,
    loadingOlder,
    loadOlder,
    onSent,
    handlePromptAction,
    handleWizardAction,
    handlePreviewAction,
    handleMultiSelectAction,
    handleMenuAction,
    armed,
    setArmed,
    focusFromMirror,
  };
}
