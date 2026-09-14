import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { TerminalSquare } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { FindBar } from "@/components/find-bar";
import { AgentIcon } from "@/components/agent-icon";
import { ShellBadge, StatusDot } from "@/components/status-badge";
import { PaneDetailsSheet, type PaneDetailsProps } from "@/components/pane-details-sheet";
import { useSwipeUp } from "@/hooks/use-swipe";
import { tracePath } from "@/lib/nav";
import { shownStatus } from "@/lib/triage";
import type { MenuPoint } from "@/lib/menu-anchor";
import type { AgentView, BridgeStatus } from "@/lib/types";
type PaneRun = NonNullable<NonNullable<AgentView["sssf"]>["runs"]>[number];
type PaneHeaderProps = {
  connection: {
    bridge: BridgeStatus;
    error: boolean;
    stalled: boolean;
    connecting: boolean;
  };
  find: {
    open: boolean;
    query: string;
    count: number;
    current: number;
    onQueryChange: (query: string) => void;
    onPrev: () => void;
    onNext: () => void;
    onOpen: () => void;
    onClose: () => void;
  };
  pane: {
    paneId: string;
    tabLabel?: string;
    isShell: boolean;
    hasOutput: boolean;
  };
  agent: AgentView | undefined;
  runs: { latest: PaneRun | undefined; live: boolean };
  onBack: () => void;
  onOpenSpace: (workspaceId: string) => void;
  /** What the title sheet shows beyond the header's own data (statusline, tab panes, switcher). */
  details: Pick<
    PaneDetailsProps,
    | "statusLines"
    | "dumpText"
    | "panes"
    | "onSelectPane"
    | "readOnly"
    | "onRenamed"
    | "onClosed"
    | "onSwitchPane"
    | "onContext"
  >;
};
// One line: back, agent logo, title, status dot. Everything else the header used to carry — the
// cwd subline, Find, Traces, the status pill — sits behind the title in PaneDetailsSheet. The find
// bar still takes over this row while it's open (`override`).
export function PaneHeader({
  connection,
  find,
  pane,
  agent,
  runs,
  onBack,
  onOpenSpace,
  details,
}: PaneHeaderProps) {
  const navigate = useNavigate();
  const { bridge, error, stalled, connecting } = connection;
  const latestRun = runs.latest;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [anchor, setAnchor] = useState<MenuPoint | null>(null);
  const titleRef = useRef<HTMLButtonElement>(null);

  function openDetails() {
    const el = titleRef.current;
    // Desktop popover: hang it under the title's left edge. Phone ignores the anchor.
    if (el) {
      const rect = el.getBoundingClientRect();
      setAnchor({ x: rect.left, y: rect.bottom + 4 });
    }
    setDetailsOpen(true);
  }
  // The swipe that used to open the pane switcher from a handle above the composer now lives on the
  // title: a swipe here opens the same sheet a tap does.
  const swipe = useSwipeUp(openDetails, 24);

  return (
    <>
      <AppHeader
        bridge={bridge}
        error={error}
        stalled={stalled}
        onBack={onBack}
        override={
          find.open ? (
            <FindBar
              query={find.query}
              onQueryChange={find.onQueryChange}
              count={find.count}
              current={find.current}
              onPrev={find.onPrev}
              onNext={find.onNext}
              onClose={find.onClose}
            />
          ) : undefined
        }
        // The status dot is the rightmost thing on every pane screen (it's what you glance at). It
        // is dimmed while the connection isn't live, so a frozen "working"/"idle" from the last
        // snapshot doesn't masquerade as current. A bare shell shows the muted "shell" tag.
        rightLead={
          agent ? (
            pane.isShell ? (
              <ShellBadge stale={connecting} className="mr-2" />
            ) : (
              <StatusDot
                status={shownStatus(agent)}
                runningCommand={agent.runningCommand}
                labelled
                live
                stale={connecting}
                surface="bg-muted"
                className="mr-3 size-3"
              />
            )
          ) : undefined
        }
      >
        {/* Title: the agent's brand logo (the agent name would just repeat it, so it's dropped) and
            the pane's name. Tapping or swiping it opens the details sheet. */}
        {agent ? (
          <button
            ref={titleRef}
            type="button"
            onClick={openDetails}
            {...swipe}
            aria-label="Pane details"
            aria-haspopup="dialog"
            aria-expanded={detailsOpen}
            className="-mx-1 flex min-h-11 min-w-0 flex-1 select-none [-webkit-touch-callout:none] items-center gap-2.5 rounded-lg px-1 text-left transition-colors active:bg-muted/60"
          >
            {pane.isShell ? (
              <div className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-muted">
                <TerminalSquare className="size-3 text-muted-foreground" />
              </div>
            ) : (
              // Deliberately smaller than the size-8 Sightr mark beside it — the agent logo is the
              // pane's subject, not a second brand competing with Sightr's for the header.
              <AgentIcon agent={agent.agent} className="size-6" />
            )}
            {/* A user-set pane label leads, then Herdr's live agent name, then Claude's
                /rename session name, otherwise the default space › tab. */}
            <span className="min-w-0 flex-1 truncate font-semibold leading-tight">
              {agent.paneLabel ??
                agent.agentName ??
                agent.sessionName ??
                `${agent.workspaceLabel}${pane.tabLabel ? ` › ${pane.tabLabel}` : ""}`}
            </span>
          </button>
        ) : (
          <div className="min-w-0 flex-1">
            <span className="truncate font-semibold">(agent gone)</span>
          </div>
        )}
      </AppHeader>

      {agent && (
        <PaneDetailsSheet
          open={detailsOpen}
          onClose={() => setDetailsOpen(false)}
          anchor={anchor}
          agent={agent}
          currentPaneId={pane.paneId}
          onOpenSpace={() => onOpenSpace(agent.workspaceId)}
          // Offered only when there's buffered output to search; opening it freezes the tail.
          find={{ available: pane.hasOutput, onOpen: find.onOpen }}
          // Traces opens the SSSF visualiser scoped to the ADW runs THIS pane launched — the tracer
          // wrote the pane's HERDR_PANE_ID on each run, so this is attribution, not a guess from
          // cwd. Offered only when the pane has at least one such run; `live` while one still goes.
          traces={{
            available: latestRun !== undefined,
            live: runs.live,
            onOpen: () => {
              if (latestRun) navigate(tracePath(agent.workspaceId, latestRun.repo, { pane: pane.paneId }));
            },
          }}
          {...details}
        />
      )}
    </>
  );
}
