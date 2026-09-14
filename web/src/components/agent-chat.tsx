import { useEffect, useMemo, useState } from "react";
import { useRevalidator } from "react-router";
import { ArrowUpToLine, Loader2 } from "lucide-react";
import { useDashPrefs, openForCount } from "@/hooks/use-dash-prefs";
import { useDisplayPrefs } from "@/hooks/use-display-prefs";
import { isConnecting } from "@/lib/connection";
import { useDesktop } from "@/lib/desktop";
import { ChatMessageList } from "@/components/ui/chat/chat-message-list";
import { BottomSheet } from "@/components/ui/sheet";
import { AnsiMirror } from "@/components/ansi-output";
import { cn } from "@/lib/utils";
import { Composer } from "@/components/composer";
import { usePaneView } from "@/hooks/use-pane-view";
import { PaneHeader } from "@/components/pane-header";
import { TranscriptView } from "@/components/transcript-view";
import { ThinkingPulse } from "@/components/thinking-pulse";
import { ThreadSidebar } from "@/components/agent-sidebar";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { StatusArea } from "@/components/status-area";
import { useOpenSpace } from "@/hooks/use-open-space";
import { useDropUpload } from "@/hooks/use-drop-upload";
import { clearPasteHold, setPasteHold } from "@/lib/paste-hold";
import { lineText } from "@/lib/blocks";
import {
  dumpTail,
  journalHasAnyUser,
  journalHasUser,
  loadPendingUsers,
  mergePendingUsers,
  savePendingUsers,
  thinkSnip,
  type PendingUserSend,
} from "@/lib/thinking-pulse";
import { isReadOnly } from "@/lib/types";
import { canonicalAgent } from "@shared/agents";
import type { AgentView, BridgeStatus, DeviceAuth } from "@/lib/types";

interface AgentChatProps {
  paneId: string;
  agent: AgentView | undefined;
  agents: AgentView[];
  shellPanes: AgentView[];
  /** Label of the pane's tab, shown in the header as "space › tab". */
  tabLabel?: string;
  /** Pane output from the route loader (refreshed by polling/revalidation). */
  text: string;
  /** The scrollback window `text` was fetched with — tells a grown fetch from a stale in-flight poll. */
  requestedLines?: number;
  /** The pane's `revision` for `text` — the race guard checks a tapped menu against this. */
  revision?: number;
  /** Per-device auth from the snapshot; an unauthorised device drops the composer to read-only. */
  device?: DeviceAuth;
  // Global connection state — fed straight to the shared AppHeader, which drives the header Sightr
  // mark (gallop/rest, identically to the dashboard), and lets us dim the stale StatusBadge while not
  // live. Defaults describe a healthy link so tests that don't care render "live".
  bridge?: BridgeStatus | undefined;
  error?: boolean;
  stalled?: boolean;
  /** Up one level: the header's "‹" (to the pane's space), and where a closed pane/tab lands. */
  onBack: () => void;
  onSelect: (paneId: string) => void;
}

// At most one drawer/sheet is open at a time; null = none. (The composer's own Keys/Quick/Agent
// sheets and the header's pane details sheet are separate and live inside those components.)
type Drawer = "switcher" | null;

// The detail view is a live terminal mirror with the journal stacked above it. Sending a message
// replaces the TUI viewport with thinking; the journal is the pane.
// Show terminal is off by default. A usable journal replaces the dump while idle; blocked agents,
// armed Type, open Find, panes with no journal, and unlifted blocking widgets force the dump back,
// avoiding a doubled newest turn; the composer's Terminal toggle brings the dump back. Lifted prompt
// buttons still render under the journal.
// Off + working still shows a thinking pulse (elapsed + dump-tail snip) and the send as a You turn
// until the jsonl row lands — the dump stays hidden.
// The pane's output comes from the route loader (`text`); polling revalidates it. Replies/keys are
// confirmed via the header status line (`setStatus`), then a revalidation pulls the fresh output.
//
// This shell owns the pane frame: the header (one line; its title opens the pane details sheet with
// the cwd, statusline, tab panes, Find, Traces and the cross-space switcher; the find bar takes the
// row over while find is open), the terminal mirror (freeze, find highlighting, transcript above
// the live tail, load-older scrollback on shells), and the switcher sheet. The composer cluster —
// draft, send, keys, slash-commands, image upload, display prefs — lives in <Composer>; it reaches
// back here only to re-follow the tail after a send and focus on a mirror tap.

/** Slash the Context row sends. Pi has no `/context`; `/session` is the tokens + cost dump. */
function contextSlashFor(agent: string): "/context" | "/session" | null {
  const family = canonicalAgent(agent);
  if (family === "claude" || family === "grok") return "/context";
  if (family === "pi") return "/session";
  return null;
}

export function AgentChat({
  paneId,
  agent,
  agents,
  shellPanes,
  tabLabel,
  text,
  requestedLines = 0,
  revision = 0,
  device,
  bridge = "connected",
  error = false,
  stalled = false,
  onBack,
  onSelect,
}: AgentChatProps) {
  const revalidator = useRevalidator();
  // Poll-truth "is the data on screen not live". The header (AppHeader) reads the same inputs to drive
  // the Sightr mark + pill; here we use it to dim the StatusBadge, so the badge stops presenting the
  // last snapshot's status as current while we're reconnecting/lost, and restores instantly on recovery.
  const connecting = isConnecting({ bridge, error, stalled });
  // Single display-prefs instance: the View controls (in <Composer>) write it, the mirror reads it.
  const { prefs, stepFontSize, setRawTerminal, setTapToFocus, setShowTerminal, setShowThinking } =
    useDisplayPrefs();
  // Raw-terminal controls chrome stripping only. Dialog grammars still run so detected prompts remain
  // tappable below the verbatim dump, which remains available as the keys-pad escape hatch.
  const stripChrome = !prefs.rawTerminal;
  const isShell = agent?.kind === "shell";
  // The ADW runs this pane launched (bridge-stamped from the tracer's pane_id). The header offers a
  // Traces button only when there is at least one, and dots it while any of them is still running.
  const paneRuns = agent?.sssf?.runs ?? [];
  const latestRun = paneRuns[0];
  const runLive = paneRuns.some((r) => r.status === "running");
  // This device isn't allowlisted to type into agents: the backend rejects every write, so the
  // composer drops to read-only (and shows a banner). The mirror still polls (reading is fine).
  const readOnly = isReadOnly(device);
  const { on: desktop, typing } = useDesktop();

  // Drawers/sheets are mutually exclusive — at most one open. A single value makes that invariant
  // unrepresentable to violate.
  const [drawer, setDrawer] = useState<Drawer>(null);
  const closeDrawer = () => setDrawer(null);

  const gone = !agent;
  useDropUpload({
    paneId,
    enabled: desktop && !gone && !readOnly,
    onPath: (path) =>
      setPasteHold({
        kind: "path",
        path,
        onSend: () => {
          clearPasteHold();
          composerRef.current?.typePath(path);
        },
        onDiscard: clearPasteHold,
      }),
  });

  // Fold state for the "Switch pane" sheet's two long tails, shared with the dashboard so one
  // "hide the long tail" preference means the same thing in both places.
  const dash = useDashPrefs();

  const {
    listRef,
    composerRef,
    setFollowing,
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
  } = usePaneView({
    paneId,
    agent,
    text,
    requestedLines,
    revision,
    readOnly,
    stripChrome,
    tapToFocus: prefs.tapToFocus,
    desktop,
    typing,
  });

  // The journal is the pane's main view only when it actually loaded usable turns. Keep the dump
  // available for prompts and other states where the TUI contains information the journal cannot.
  const hasJournal = historyAvailable && inline.unavailable === undefined && inline.entries.length > 0;
  const showDump =
    prefs.showTerminal ||
    !hasJournal ||
    agent?.status === "blocked" ||
    armed ||
    findOpen ||
    needsDump;

  // Last send sits in the journal immediately. The jsonl row often lands only when the turn finishes,
  // so without this the conversation goes blank of "You" until then. Dropped once the log has it, or
  // on /clear / /new. A queue, not a single slot: overwriting lost Grok's first send when a second
  // prompt landed first (Grok writes the opening user_query late, or not at all for a start word).
  const [pendingUsers, setPendingUsers] = useState<PendingUserSend[]>(() => loadPendingUsers(paneId));
  useEffect(() => {
    setPendingUsers((prev) => {
      const next = prev.filter((p) => !journalHasUser(inline.entries, p.text));
      return next.length === prev.length ? prev : next;
    });
  }, [inline.entries]);
  useEffect(() => {
    savePendingUsers(paneId, pendingUsers);
  }, [paneId, pendingUsers]);
  const handleSent = (sent: string) => {
    const t = sent.trim();
    if (/^\/(clear|new)(\s|$)/.test(t)) setPendingUsers([]);
    else if (t !== "") {
      setPendingUsers((prev) => {
        if (prev.some((p) => p.text.replace(/\s+/g, " ").trim() === t.replace(/\s+/g, " "))) return prev;
        return [
          ...prev,
          { text: t, at: Date.now(), opening: prev.length === 0 && !journalHasAnyUser(inline.entries) },
        ];
      });
    }
    onSent(sent);
  };
  const transcriptEntries = mergePendingUsers(inline.entries, pendingUsers);
  const inFlight = pendingUsers.filter((p) => !p.opening && !journalHasUser(inline.entries, p.text));

  // Dump stays hidden while working. The pulse is the live tell: elapsed clock plus the last
  // sentence (or last ~80 chars) of the chrome-stripped dump we still poll. Start on the send
  // itself — Herdr's working status can lag a poll or two, and runningCommand is the previous
  // journal tail, not this turn. Sit above the composer so a phone keyboard doesn't cover it.
  const showPulse =
    !showDump && (agent?.status === "working" || inFlight.length > 0) && agent?.status !== "blocked";
  const [thinkAt, setThinkAt] = useState<number | null>(null);
  const inFlightAt = inFlight.at(-1)?.at;
  useEffect(() => {
    if (showPulse) setThinkAt((at) => at ?? inFlightAt ?? Date.now());
    else setThinkAt(null);
  }, [showPulse, inFlightAt]);
  const pulseStart = inFlightAt ?? thinkAt;
  const thinkSnipText = useMemo(() => thinkSnip(dumpTail(blocks)), [blocks]);

  // NOTE: the composer is deliberately NOT auto-focused on open/switch — that would pop the Android
  // keyboard and cover the output. You read the pane first, then tap the input to type. (Explicit
  // actions inside the composer still focus it; the mirror tap focuses it via composerRef.)

  // Switch to another thread from the details sheet's pane list or the Switch pane sheet
  // (DetailRoute keys AgentChat by pane, so this remounts fresh — composer resets — same as opening
  // from home).
  function switchTo(id: string) {
    closeDrawer();
    if (id !== paneId) onSelect(id);
  }

  const openSpaceNav = useOpenSpace();

  // Open a space from the nav hub — expand it in the tree and navigate home. A step back up out of
  // the pane, so it slides backward.
  function openSpace(workspaceId: string) {
    closeDrawer();
    openSpaceNav(workspaceId);
  }

  const contextSlash =
    agent && !readOnly && !isShell ? contextSlashFor(agent.agent) : null;

  // max-w-[100dvw] is a phone guard (the mirror must never widen the page). In desktop mode the
  // grid track (minmax(0,1fr)) is the constraint and the viewport is not this element's width.
  return (
    <div
      className={
        desktop ? "flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden" : "flex min-h-0 w-full min-w-0 max-w-[100dvw] flex-1 flex-col overflow-x-hidden"
      }
    >
      {/* Header — the SAME AppHeader shell the dashboard and space mount, so the Sightr mark is
          identical on every screen (no hand-rolled bar to drift). One line: back, agent logo, title,
          status dot; the find bar takes the row over while searching. The title opens the details
          sheet, which carries the tab's other panes (with rename / close), the statusline, and the
          cross-space switcher. */}
      <PaneHeader
        connection={{ bridge, error, stalled, connecting }}
        find={{
          open: findOpen,
          query: findQuery,
          count: matchCount,
          current: currentMatch,
          onQueryChange: setFindQuery,
          onPrev: () => gotoMatch(-1),
          onNext: () => gotoMatch(1),
          onOpen: openFind,
          onClose: closeFind,
        }}
        pane={{ paneId, tabLabel, isShell, hasOutput: display !== "" }}
        agent={agent}
        runs={{ latest: latestRun, live: runLive }}
        onBack={onBack}
        onOpenSpace={openSpace}
        details={{
          statusLines,
          dumpText: lines.map(lineText).join("\n"),
          panes: agent
            ? [...agents, ...shellPanes]
                .filter((p) => p.workspaceId === agent.workspaceId && p.tabId === agent.tabId)
                .sort((a, b) => a.paneId.localeCompare(b.paneId))
            : [],
          onSelectPane: switchTo,
          readOnly,
          onRenamed: () => revalidator.revalidate(),
          // Mirror closePane's success branch: closing the open pane returns Home, else revalidate.
          onClosed: (id) => (id === paneId ? onBack() : revalidator.revalidate()),
          // The cross-space switcher is phone-only; desktop lists every pane in the sidebar.
          onSwitchPane: desktop ? undefined : () => setDrawer("switcher"),
          // Claude and Grok have `/context`; Pi has `/session` (tokens + cost). Show the terminal
          // so the TUI card isn't hidden behind Show-terminal-off, then send the slash. Shells
          // and a locked composer omit it.
          onContext: contextSlash
            ? () => {
                setShowTerminal(true);
                composerRef.current?.sendSlash(contextSlash);
              }
            : undefined,
        }}
      />

      {/* Content region below the header — the mirror inside is the scroller. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Status line — a slim row pinned directly below the header (NOT the scrolling mirror), so a
            "Sent" / "changed" notice reads at the top instead of floating over the terminal tail
            (prompt/cursor + up-levelled prompt buttons) it used to cover. Renders nothing — no
            reserved space — when idle; auto-dismisses. */}
        <StatusArea className="mx-3 mt-1.5 shrink-0" />

        {/* Read-only notice when this device isn't allowlisted (the composer below is disabled too). */}
        <ReadOnlyBanner device={device} />

        {/* Terminal mirror — tapping it focuses the composer so you can start typing right away
            (unless you're selecting text to copy, which the tap must not collapse). */}
        {/* min-w-0 only — do NOT set overflow-x-hidden here: that forces overflow-y to `auto` (CSS
            quirk) and makes this wrapper a second vertical scroller competing with ChatMessageList. */}
        {/* border-t: every band in this stack draws its own TOP edge, so whichever one ends up last
            (the status line, the read-only banner, or nothing) still has a boundary under it.
            Without this the chrome ran straight into terminal output and the two read as one
            surface. */}
        <div
          data-testid="mirror-region"
          className={cn("min-h-0 min-w-0 flex-1 border-t border-border/40", desktop && armed && "ring-2 ring-inset ring-you")}
          onClick={focusFromMirror}
        >
          <ChatMessageList ref={listRef} dep={display} onAtBottomChange={setFollowing} hasNew={hasNew} className="px-2 py-3">
            <>
              {/* Agent panes: last transcript turns sit above the live tail so a swipe up reads
                  the conversation. The dump is off by default and controlled by the composer's Terminal
                  toggle when the journal is usable; blocked, Type, Find, no-journal, and unlifted
                  blocking widgets (Grok checkbox asks) still force it and show the Live seam. Lifted
                  buttons still render when the dump is hidden. Shells (primary screen, real scrollback
                  ring) still page the terminal buffer with Load older. */}
              {transcriptEntries.length > 0 && (
                <div className="mb-3">
                  {inline.loading && (
                    <div className="mb-2 flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" />
                      Loading…
                    </div>
                  )}
                  <TranscriptView
                    entries={transcriptEntries}
                    agent={agent?.agent}
                    showThinking={prefs.showThinking}
                  />
                  {showDump && display ? (
                    <div className="mt-3 flex items-center gap-2">
                      <div className="h-px flex-1 bg-border" />
                      <span className="text-[11px] font-medium text-muted-foreground">Live</span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                  ) : null}
                </div>
              )}
              {!historyAvailable && moreScrollback ? (
                <button
                  type="button"
                  onClick={loadOlder}
                  disabled={loadingOlder}
                  className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50 disabled:opacity-60"
                >
                  {loadingOlder ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUpToLine className="size-3.5" />}
                  {loadingOlder ? "Loading…" : "Load older"}
                </button>
              ) : null}
              {showDump ? (
                display ? <AnsiMirror
                  lines={lines}
                  blocks={blocks}
                  fontSize={prefs.fontSize}
                  query={findOpen ? findQuery : ""}
                  currentMatch={findOpen ? currentMatch : -1}
                  onMatchCount={findOpen ? handleMatchCount : undefined}
                  rawDump={prefs.rawTerminal}
                  onPromptAction={handlePromptAction}
                  onWizardAction={handleWizardAction}
                  onPreviewAction={handlePreviewAction}
                  onMultiSelectAction={handleMultiSelectAction}
                  onMenuAction={handleMenuAction}
                  promptDisabled={readOnly || gone}
                /> : (
                  <div className="py-16 text-center text-sm text-muted-foreground">(no recent output)</div>
                )
              ) : dialogPresent && display ? (
                <AnsiMirror
                  lines={lines}
                  blocks={blocks}
                  fontSize={prefs.fontSize}
                  hideRaw
                  onPromptAction={handlePromptAction}
                  onWizardAction={handleWizardAction}
                  onPreviewAction={handlePreviewAction}
                  onMultiSelectAction={handleMultiSelectAction}
                  onMenuAction={handleMenuAction}
                  promptDisabled={readOnly || gone}
                />
              ) : null}
            </>
          </ChatMessageList>
        </div>

        {/* Bottom region: the thinking pulse + composer. The pane-switch handle and the agent
            statusline strip that sat here moved into the header's details sheet, so the message
            list gets the rows back. The status line USED to float here as an overlay just above
            the composer, but it covered the terminal tail — it now lives as a slim row just below
            the header. */}
        <div className={cn("relative", desktop && "shrink-0")}>
          {showPulse && pulseStart !== null ? (
            <ThinkingPulse
              startedAt={pulseStart}
              snip={prefs.showThinking ? thinkSnipText : ""}
            />
          ) : null}

          <Composer
            ref={composerRef}
            paneId={paneId}
            agent={agent?.agent}
            isShell={isShell}
            gone={gone}
            readOnly={readOnly}
            dialogPresent={dialogPresent}
            agentBlocked={agent?.status === "blocked"}
            promptBlock={promptBlock}
            onPromptAction={handlePromptAction}
            text={text}
            terminalDraft={terminalDraft}
            rawTerminalDraft={rawTerminalDraft}
            prefs={prefs}
            stepFontSize={stepFontSize}
            setRawTerminal={setRawTerminal}
            setTapToFocus={setTapToFocus}
            setShowTerminal={setShowTerminal}
            setShowThinking={setShowThinking}
            onSent={handleSent}
            onArmedChange={setArmed}
          />
        </div>
      </div>

      {/* Phone-only cross-space switcher sheet, reached from "Switch pane…" in the details sheet;
          desktop switches from the sidebar. */}
      {!desktop && (
        <BottomSheet open={drawer === "switcher"} onClose={closeDrawer} title="Switch pane">
          <ThreadSidebar
            agents={agents}
            shellPanes={shellPanes}
            currentPaneId={paneId}
            error={error}
            onSelect={switchTo}
            recentOpen={dash.prefs.recentOpen}
            onRecentOpenChange={dash.setRecentOpen}
            // Shells fold on the same count rule Spaces uses: on a herd with dozens of bare shells
            // they'd otherwise bury the agents you opened this sheet to reach.
            shellsOpen={openForCount(dash.prefs.shellsOpen, shellPanes.length)}
            onShellsOpenChange={dash.setShellsOpen}
            className="px-0 py-1"
          />
        </BottomSheet>
      )}
    </div>
  );
}
