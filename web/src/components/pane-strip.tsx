import { useState } from "react";
import { Plug, TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusDot } from "@/components/status-badge";
import { PaneActionsSheet } from "@/components/pane-actions-sheet";
import { contextMenuProps, type MenuPoint } from "@/lib/menu-anchor";
import { paneDisplayName } from "@/lib/types";
import { shownStatus } from "@/lib/triage";
import type { AgentView } from "@/lib/types";

interface PaneStripProps {
  /** The panes that share the current tab (agents + shells), in stable order. */
  panes: AgentView[];
  currentPaneId: string;
  onSelect: (paneId: string) => void;
  /** Drop the right-click write actions when the device isn't authorised. */
  readOnly?: boolean;
  /** Revalidate after a rename. Right-click pane actions turn on only when this AND onClosed are set. */
  onRenamed?: () => void;
  /** Navigate/refresh after a close (Home if it's the open pane). Enables right-click with onRenamed. */
  onClosed?: (paneId: string) => void;
  /** `strip`: the original horizontal pill row. `list`: the same pills stacked as full-width rows,
   *  for the pane details sheet. */
  layout?: "strip" | "list";
}

// The panes within the current tab, one level below the tab bar (space › tab › pane). Mobile
// deliberately doesn't replicate the desktop's pane tiling — a tab can hold several panes, and this
// is just a quick way to flip between them. Rendered only when the tab actually holds more than one
// pane (a lone pane needs no switcher). It used to be a row under the pane header; since the header
// went to one line it lives in the pane details sheet, stacked as rows (`layout="list"`).
// A right-click on a pill opens its actions sheet (rename / close) when the parent wires the actions.
export function PaneStrip({
  panes,
  currentPaneId,
  onSelect,
  readOnly,
  onRenamed,
  onClosed,
  layout = "strip",
}: PaneStripProps) {
  const [sheetPane, setSheetPane] = useState<AgentView | null>(null);
  const [anchor, setAnchor] = useState<MenuPoint | null>(null);
  // Actions need both callbacks wired (revalidate on rename, navigate on close); without them the
  // pills stay plain tap-to-switch — right-click is inert.
  const actionsEnabled = !!onRenamed && !!onClosed;

  if (panes.length < 2) return null;

  const list = layout === "list";
  return (
    <>
      <div
        className={
          list
            ? "flex flex-col gap-1"
            : "flex items-center gap-2 overflow-x-auto border-t border-border/40 bg-muted/20 px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        }
      >
        <SectionLabel className={list ? "px-3 pb-1" : undefined}>Panes</SectionLabel>
        {panes.map((p) => (
          <PanePill
            key={p.paneId}
            pane={p}
            active={p.paneId === currentPaneId}
            list={list}
            onSelect={onSelect}
            onMenu={actionsEnabled ? (at) => { setAnchor(at); setSheetPane(p); } : undefined}
            // Tapping the already-active pill would otherwise be a useless re-navigate; repurpose it
            // to open the same actions sheet a right-click would, so it's not a dead tap.
            onTapActive={actionsEnabled ? () => { setAnchor(null); setSheetPane(p); } : undefined}
          />
        ))}
      </div>

      {actionsEnabled && (
        <PaneActionsSheet
          open={sheetPane !== null}
          onClose={() => setSheetPane(null)}
          pane={sheetPane}
          readOnly={readOnly}
          onRenamed={onRenamed}
          onClosed={onClosed}
          anchor={anchor}
        />
      )}
    </>
  );
}

function PanePill({
  pane,
  active,
  list,
  onSelect,
  onMenu,
  onTapActive,
}: {
  pane: AgentView;
  active: boolean;
  /** Full-width row in the details sheet instead of a pill in a strip. */
  list: boolean;
  onSelect: (paneId: string) => void;
  onMenu?: (at: MenuPoint) => void;
  /** A plain tap on the pill when it's already `active` — opens actions instead of a no-op re-select. */
  onTapActive?: () => void;
}) {
  const isShell = pane.kind === "shell";
  const isPluginShell = isShell && Boolean(pane.paneLabel);
  // The "pN" suffix of the pane id disambiguates same-named panes (two claudes in one tab).
  const tag = pane.paneId.split(":").pop();
  // A user label, then Herdr's live agent name, then Claude's /rename session name, then the
  // agent/shell name (see paneDisplayName) — the icon still conveys which agent it is.
  const name = paneDisplayName(pane);

  // A contextmenu event never produces a click, so this only ever sees a genuine tap.
  function onClick() {
    if (active && onTapActive) {
      onTapActive();
      return;
    }
    onSelect(pane.paneId);
  }

  return (
    <button
      type="button"
      onClick={onClick}
      {...contextMenuProps(onMenu)}
      aria-current={active ? "true" : undefined}
      title={active && onTapActive ? "Tap for pane actions" : undefined}
      className={cn(
        // select-none + -webkit-touch-callout:none stop iOS Safari's selection loupe / touch callout,
        // whose native right-click gesture otherwise fires native touch callout and kills our selection behavior.
        "flex shrink-0 select-none [-webkit-touch-callout:none] items-center whitespace-nowrap text-sm font-medium transition-colors",
        list
          ? "w-full gap-3 rounded-lg px-3 py-2.5 text-left"
          : "gap-1.5 rounded-full px-2.5 py-1 active:scale-95",
        active
          ? list
            ? "bg-accent text-accent-foreground"
            : "bg-primary text-primary-foreground"
          : list
            ? "hover:bg-accent active:bg-muted"
            : "bg-muted text-muted-foreground hover:bg-muted/70",
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
      <span className={list ? "min-w-0 flex-1 truncate" : undefined}>{name}</span>
      <span
        className={cn(
          "font-mono text-[10px]",
          active && !list ? "text-primary-foreground/70" : "text-muted-foreground/60",
        )}
      >
        {tag}
      </span>
    </button>
  );
}
