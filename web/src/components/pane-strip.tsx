import { Plug, TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusDot } from "@/components/status-badge";
import { paneDisplayName } from "@/lib/types";
import { shownStatus } from "@/lib/triage";
import type { AgentView } from "@/lib/types";

interface PaneStripProps {
  /** The panes that share the current tab (agents + shells), in stable order. */
  panes: AgentView[];
  currentPaneId: string;
  onSelect: (paneId: string) => void;
}

// The panes within the current tab, one level below the tab bar (space › tab › pane), stacked as
// rows in the pane menu. Rendered only when the tab actually holds more than one pane (a lone pane
// needs no switcher). It is a switcher only: the open pane's Rename / Close are rows of the pane
// menu itself, and another pane's are one tap away once you switch to it (or on its ⋯ in Spaces).
export function PaneStrip({ panes, currentPaneId, onSelect }: PaneStripProps) {
  if (panes.length < 2) return null;
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel className="px-3 pb-1">Panes</SectionLabel>
      {panes.map((p) => (
        <PaneRow
          key={p.paneId}
          pane={p}
          active={p.paneId === currentPaneId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function PaneRow({
  pane,
  active,
  onSelect,
}: {
  pane: AgentView;
  active: boolean;
  onSelect: (paneId: string) => void;
}) {
  const isShell = pane.kind === "shell";
  const isPluginShell = isShell && Boolean(pane.paneLabel);
  // The "pN" suffix of the pane id disambiguates same-named panes (two claudes in one tab).
  const tag = pane.paneId.split(":").pop();
  // A user label, then Herdr's live agent name, then Claude's /rename session name, then the
  // agent/shell name (see paneDisplayName) — the icon still conveys which agent it is.
  const name = paneDisplayName(pane);

  return (
    <button
      type="button"
      // The open pane is already on screen; tapping it is a no-op rather than a re-navigate.
      onClick={() => {
        if (!active) onSelect(pane.paneId);
      }}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full shrink-0 select-none [-webkit-touch-callout:none] items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent active:bg-muted",
      )}
    >
      {isShell ? (
        isPluginShell ? (
          <Plug className="size-3.5 shrink-0" />
        ) : (
          <TerminalSquare className="size-3.5 shrink-0" />
        )
      ) : (
        <StatusDot status={shownStatus(pane)} runningCommand={pane.runningCommand} live />
      )}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="font-mono text-[10px] text-muted-foreground/60">{tag}</span>
    </button>
  );
}
