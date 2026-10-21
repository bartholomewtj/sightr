// Adapted from T3 Code apps/web/src/components/chat/V2LifecycleRow.tsx @ db5919d87 (MIT, see THIRD_PARTY.md).
// The standalone lifecycle rows a herdr journal can produce: `run_interrupt_result` (T3's danger
// divider), `compaction` (T3's divider label, here with the kept summary behind a tap) and `subagent`.
// A subagent is drawn by `SubagentGroup.tsx` (T32: one card per run); T3's `SubagentTimelineLink` row
// (avatar with a status dot, title, status or detail, elapsed) is the pattern for each agent row there.
// Changes from upstream:
// - No environment atoms or provider-instance icons: a subagent's facts come on the item itself
//   (Sightr's `model`, `agentStatus`, `durationMs`, `tokens`, `toolUses`), and the avatar is a bot icon.
// - There is no child thread to open (journals do not link one), so a tap opens the row in place:
//   T3's hover card (`SubagentTimelineTooltip`) becomes a details panel, because a phone has no hover.
// - Handoff, fork, thread-created and interrupt-request rows are left out (no herdr source).
// - Phone pass: the subagent row and the compaction toggle are 44 px targets on a coarse pointer.
// - With no result yet (a background agent) the subagent row's second line is its prompt, not a bare
//   status; the bridge turns the row completed or failed when the agent's task-notification lands.
import type { TurnItem } from "@shared/v2/contracts";
import { XIcon } from "lucide-react";
import { useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { SubagentGroupRow } from "./SubagentGroup";
import { TimelineSystemDivider } from "./TimelineSystemDivider";

const V2_LIFECYCLE_ITEM_TYPES = new Set<TurnItem["type"]>(["run_interrupt_result", "compaction", "subagent"]);

export function isV2LifecycleItem(item: TurnItem): boolean {
  return V2_LIFECYCLE_ITEM_TYPES.has(item.type);
}

export function V2LifecycleRow(props: { readonly item: TurnItem; readonly createdAt: number }) {
  const { item } = props;
  if (item.type === "run_interrupt_result") {
    return <TimelineSystemDivider label="Run interrupted" detail={item.message} tone="danger" icon={XIcon} />;
  }
  if (item.type === "compaction") return <CompactionRow item={item} />;
  // Normally drawn as its run's card by the timeline (`row.subagents`); a lone item is a card of one.
  if (item.type === "subagent") return <SubagentGroupRow agents={[item]} />;
  return null;
}

/** T3's compaction label, by status. */
export function compactionLabel(item: Extract<TurnItem, { type: "compaction" }>): string {
  return item.status === "failed"
    ? "Context compaction failed"
    : item.status === "cancelled" || item.status === "interrupted"
      ? "Context compaction stopped"
      : item.status === "pending" || item.status === "running" || item.status === "waiting"
        ? "Compacting context"
        : "Context compacted";
}

function CompactionRow({ item }: { item: Extract<TurnItem, { type: "compaction" }> }) {
  const [open, setOpen] = useState(false);
  const tokenDetail =
    item.beforeTokenCount === undefined && item.afterTokenCount === undefined
      ? null
      : `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"} tokens`;
  const summary = item.summary?.trim() ?? "";
  return (
    <div data-v2-item-type="compaction">
      <TimelineSystemDivider
        label={compactionLabel(item)}
        detail={tokenDetail ?? (summary ? (open ? "Hide summary" : "Show summary") : null)}
        {...(summary
          ? { actionLabel: open ? "Hide the compaction summary" : "Show the compaction summary", onAction: () => setOpen((v) => !v) }
          : {})}
      />
      {open && summary ? (
        <div className="mx-1 mb-2 max-h-[min(28rem,60dvh)] overflow-y-auto rounded-lg border border-border/70 bg-card/60 p-3 text-sm wrap-anywhere">
          <ChatMarkdown text={summary} isStreaming={false} headingLevelOffset={3} lineBreaks />
          {item.truncated ? (
            <p className="mt-2 text-2xs text-muted-foreground italic">The journal cut this summary; the full text is in the agent's own log.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
