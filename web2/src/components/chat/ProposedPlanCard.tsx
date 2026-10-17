// Adapted from T3 Code apps/web/src/components/chat/ProposedPlanCard.tsx @ db5919d87 (MIT, see THIRD_PARTY.md).
// Same card: a "Plan" badge and the plan's title, the markdown collapsed past 20 lines or 900
// characters to T3's 10-line preview with a fade, and an Expand/Collapse button. Changes from upstream:
// - Copy is `MessageCopyButton` beside the title instead of the actions menu; no "Download as
//   markdown" (a phone saves it from the clipboard) and no "Save to workspace" (no write route).
// - No environment, cwd or thread-find reveal props; `ChatMarkdown` is Sightr's.
// - Phone pass: the title wraps instead of truncating, and the Expand button has a 44 px target.
// The card shows the plan the agent proposed (Claude's ExitPlanMode); approving it stays the
// terminal's own menu, which Sightr draws as a runtime request (T04/T12).
import { memo, useState } from "react";

import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "../../t3/shared/proposedPlanText";
import { buildCollapsedProposedPlanPreviewMarkdown, normalizePlanMarkdownForExport } from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { MessageCopyButton } from "./MessageCopyButton";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  truncated = false,
}: {
  planMarkdown: string;
  /** Sightr: the journal adapter cut the plan. */
  truncated?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const isCollapsed = canCollapse && !expanded;

  return (
    <div className="rounded-3xl border border-border/80 bg-card/70 p-4 sm:p-5" data-proposed-plan="true">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <h3 data-thread-find-text="true" className="min-w-0 wrap-anywhere text-sm font-medium text-foreground">
            {title}
          </h3>
        </div>
        <MessageCopyButton text={normalizePlanMarkdownForExport(planMarkdown)} />
      </div>
      <div className="mt-4">
        <div className={cn("relative", isCollapsed && "max-h-104 overflow-hidden")} data-thread-find-text="true">
          <ChatMarkdown
            text={isCollapsed ? (collapsedPreview ?? "") : displayedPlanMarkdown}
            isStreaming={false}
            headingLevelOffset={3}
          />
          {isCollapsed ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {truncated && !isCollapsed ? (
          <p className="mt-2 text-2xs text-muted-foreground italic">The journal cut this plan; the full text is in the agent's own log.</p>
        ) : null}
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:min-h-11"
              data-scroll-anchor-ignore
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
});
