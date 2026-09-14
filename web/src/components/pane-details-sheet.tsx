import type { ReactNode } from "react";
import { ArrowLeftRight, Gauge, LayoutGrid, Search } from "lucide-react";

import { contextUsageFrom } from "@/lib/context-usage";
import { lineText, type StyledLine } from "@/lib/blocks";
import { cn } from "@/lib/utils";
import { BottomSheet } from "@/components/ui/sheet";
import { ActionPopover } from "@/components/ui/popover";
import { useDesktop } from "@/lib/desktop";
import { LanesIcon } from "@/components/sssf-frame";
import { PaneStrip } from "@/components/pane-strip";
import { MIRROR_INVERT, MIRROR_SPACE, styleFor } from "@/components/mirror-space";
import type { MenuPoint } from "@/lib/menu-anchor";
import type { AgentView } from "@/lib/types";

// Everything the one-line pane header no longer has room for, one tap (or a swipe on the title)
// away: the full working directory, the agent's own statusline, the other panes in this tab, and
// the actions that used to be header buttons (space overview, Find, Traces). Phone: a bottom sheet.
// Desktop: a popover under the title. Every row closes the sheet when chosen, so the thing it opened
// (the find bar, the traces page, another pane) is not stacked under a dialog.

export interface PaneDetailsProps {
  agent: AgentView;
  /** The agent's own statusline rows, chrome-stripped off the mirror. Empty for raw mirrors. */
  statusLines: StyledLine[];
  /**
   * The pane dump (ANSI or plain). Grok paints `20K / 500K` on the header, which stripChrome
   * leaves in the dump rather than in statusLines. Optional — omit in tests that only cover
   * statusline percentages.
   */
  dumpText?: string;
  /** The panes sharing this tab, in stable order. The list appears only with 2+ of them. */
  panes: AgentView[];
  currentPaneId: string;
  onSelectPane: (paneId: string) => void;
  readOnly?: boolean;
  onRenamed?: () => void;
  onClosed?: (paneId: string) => void;
  onOpenSpace: () => void;
  /** Find in output — offered only when there is buffered output to search. */
  find: { available: boolean; onOpen: () => void };
  /** Traces — offered only when the pane launched at least one ADW run; `live` dots it. */
  traces: { available: boolean; live: boolean; onOpen: () => void };
  /** The cross-space switcher (ThreadSidebar). Omit on desktop, where the sidebar lists every pane. */
  onSwitchPane?: () => void;
  /**
   * Run `/context` (Claude, Grok) or `/session` (Pi). The sheet also reads a fill level off the
   * statusline when the TUI painted one (`ctx:33%`, `12% ctx`), Grok's header used/window count
   * (`20K / 500K`), and Pi's footer fill/window (`4.1%/200k`) off the dump, and shows it as the
   * trailing note. Omit on shells and when the composer cannot send.
   */
  onContext?: () => void;
}

export function PaneDetailsSheet({
  open,
  onClose,
  anchor,
  agent,
  statusLines,
  dumpText,
  panes,
  currentPaneId,
  onSelectPane,
  readOnly,
  onRenamed,
  onClosed,
  onOpenSpace,
  find,
  traces,
  onSwitchPane,
  onContext,
}: PaneDetailsProps & {
  open: boolean;
  onClose: () => void;
  /** Desktop popover anchor (the title's bottom-left). Ignored on phone. */
  anchor: MenuPoint | null;
}) {
  const desktop = useDesktop().on;
  const contextUsage = contextUsageFrom(
    [statusLines.map(lineText).join("\n"), dumpText ?? ""].join("\n"),
  );

  // Close first, then act: the find bar takes over the header row and the traces page navigates
  // away, and neither should happen under a still-open dialog.
  function pick(action: () => void) {
    onClose();
    action();
  }

  const body = (
    <div className="flex flex-col gap-3">
      {/* The full path, wrapping. The header used to show a shortened form; this is the one place
          the whole thing is readable, and it's a text node (never markup). */}
      <div className="break-all px-3 font-mono text-xs text-muted-foreground" data-testid="pane-cwd">
        {agent.cwd}
      </div>

      {statusLines.length > 0 && (
        <div className="overflow-hidden rounded-md">
          <PaneStatusLines lines={statusLines} />
        </div>
      )}

      <PaneStrip
        layout="list"
        panes={panes}
        currentPaneId={currentPaneId}
        onSelect={(id) => pick(() => onSelectPane(id))}
        readOnly={readOnly}
        onRenamed={onRenamed}
        onClosed={onClosed}
      />

      <div className="flex flex-col gap-1">
        {(onContext || contextUsage) && (
          <Row
            icon={<Gauge className="size-4 shrink-0" />}
            label="Context"
            trailing={
              contextUsage ? (
                <span className="text-xs font-normal text-muted-foreground">{contextUsage}</span>
              ) : undefined
            }
            onClick={onContext ? () => pick(onContext) : undefined}
          />
        )}
        <Row
          icon={<LayoutGrid className="size-4 shrink-0" />}
          label="Open space overview"
          onClick={() => pick(onOpenSpace)}
        />
        {find.available && (
          <Row
            icon={<Search className="size-4 shrink-0" />}
            label="Find in output"
            onClick={() => pick(find.onOpen)}
          />
        )}
        {traces.available && (
          <Row
            icon={<LanesIcon className="size-4 shrink-0" />}
            label="Traces"
            trailing={
              traces.live ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-status-running" />
                  running
                </span>
              ) : undefined
            }
            onClick={() => pick(traces.onOpen)}
          />
        )}
        {onSwitchPane && (
          <Row
            icon={<ArrowLeftRight className="size-4 shrink-0" />}
            label="Switch pane…"
            onClick={() => pick(onSwitchPane)}
          />
        )}
      </div>
    </div>
  );

  return desktop ? (
    <ActionPopover
      open={open}
      onClose={onClose}
      anchor={anchor}
      title="Pane details"
      className="max-w-[22rem]"
    >
      {body}
    </ActionPopover>
  ) : (
    <BottomSheet open={open} onClose={onClose} title="Pane details">
      {body}
    </BottomSheet>
  );
}

// One action row: icon, label, optional trailing note. Same shape as the + menu's rows and the
// action sheets' ActionRow, so the sheet reads like every other sheet.
function Row({
  icon,
  label,
  trailing,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  onClick?: () => void;
}) {
  const className =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium";
  if (!onClick) {
    return (
      <div className={className}>
        <span className="text-muted-foreground">{icon}</span>
        <span className="flex-1">{label}</span>
        {trailing}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${className} transition-colors hover:bg-accent active:bg-muted`}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  );
}

// The agent's statusline (branch, model, ctx, permission mode), which the chrome-stripping peels
// off the mirror along with the input box. It sat above the composer until the header redesign;
// now it lives in the details sheet. Verbatim text — React text nodes, so no XSS surface.
//
// STACKED, one row per line, each truncated — deliberately, over the two alternatives:
// joining the rows with a separator would put ~150 chars on a row that fits ~55 at this size on a
// phone, truncating away exactly the fields (branch, permission mode) this exists to surface;
// wrapping makes the height depend on the width and turns a column-aligned statusline into ragged
// prose. Stacking also preserves the shape the user themselves configured in the TUI, so it reads
// as the same thing they know. Height is bounded upstream (MAX_STATUS_LINES caps the run
// stripChrome will claim).
export function PaneStatusLines({ lines }: { lines: StyledLine[] }) {
  return (
    <div
      className={cn(
        "px-3 py-1.5 font-mono text-[11px] leading-tight",
        // The strip carries the agent's OWN terminal colour, so it renders in the mirror's dark
        // space and inverts in light with it (ADR 0002) — a bright statusline colour is chosen
        // against a near-black background and is illegible re-themed onto app chrome.
        MIRROR_SPACE,
        MIRROR_INVERT,
      )}
    >
      {lines.map((row, i) => (
        // Index key: these rows are a positional snapshot of the pane tail, re-derived on every
        // poll — there is no identity to preserve across renders.
        <div key={i} className="truncate">
          {row.segments.map((s, si: number) => (
            // Text nodes only — colour and weight come from the ANSI parse, never markup. Same XSS
            // boundary as the mirror.
            <span key={si} style={styleFor(s)}>
              {s.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
