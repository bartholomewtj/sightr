// Adapted from T3 Code apps/web/src/components/chat/V2LifecycleRow.tsx @ db5919d87 (MIT, see THIRD_PARTY.md).
// The standalone lifecycle rows a herdr journal can produce: `run_interrupt_result` (T3's danger
// divider), `compaction` (T3's divider label, here with the kept summary behind a tap) and `subagent`
// (T3's `SubagentTimelineLink` row: avatar with a status dot, title, status or detail, elapsed).
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
import { BotIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { formatDuration } from "~/session-logic";
import ChatMarkdown from "../ChatMarkdown";
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
  if (item.type === "subagent") return <SubagentRow item={item} />;
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

const STATUS_VISUALS: Record<TurnItem["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Queued" },
  running: { dotClass: "bg-info", label: "Running" },
  waiting: { dotClass: "bg-info", label: "Waiting" },
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

/**
 * The status a subagent row shows. The harness's own word wins where it says more than the call's
 * status: a background launch completes the call while the agent keeps running.
 */
export function subagentStatusLabel(item: Extract<TurnItem, { type: "subagent" }>): { label: string; dotClass: string } {
  switch (item.agentStatus?.toLowerCase()) {
    case "async_launched":
    case "background":
      return { label: "Running in the background", dotClass: STATUS_VISUALS.running.dotClass };
    case "running":
      return item.status === "running" ? STATUS_VISUALS.running : { label: "Still running", dotClass: STATUS_VISUALS.running.dotClass };
    default:
      return STATUS_VISUALS[item.status];
  }
}

function plainDetail(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "sonnet · 12k tokens · 3 tools · 5.4s" from what the harness reported. */
export function subagentFacts(item: Extract<TurnItem, { type: "subagent" }>): string[] {
  const facts: string[] = [];
  if (item.model) facts.push(item.model);
  if (item.tokens) facts.push(/^\d+$/.test(item.tokens) ? `${Number(item.tokens).toLocaleString()} tokens` : `${item.tokens} tokens`);
  if (item.toolUses !== undefined) facts.push(`${item.toolUses} ${item.toolUses === 1 ? "tool" : "tools"}`);
  return facts;
}

function SubagentRow({ item }: { item: Extract<TurnItem, { type: "subagent" }> }) {
  const [open, setOpen] = useState(false);
  const status = subagentStatusLabel(item);
  const failed = item.status === "failed";
  const result = item.result?.trim() ?? "";
  // Until a result lands (a background agent) the row says what the agent was asked to do.
  const detail = result ? plainDetail(result) : item.progress?.trim() || plainDetail(item.prompt);
  const title = item.title?.trim() || "Subagent";
  const facts = subagentFacts(item);
  return (
    <div data-v2-item-type="subagent" className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${title}, ${status.label}`}
        onClick={() => setOpen((v) => !v)}
        className="group/subagent flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 pointer-coarse:min-h-11"
      >
        <span
          aria-hidden
          className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted ring-2 ring-background"
        >
          <BotIcon className="size-3.5 text-muted-foreground" />
          <span className={cn("absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-background", status.dotClass)} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-xs font-medium text-foreground">{title}</span>
            {detail ? (
              <span className={cn("shrink-0 text-3xs", failed ? "text-destructive" : "text-muted-foreground")}>{status.label}</span>
            ) : null}
          </span>
          <span className={cn("block truncate text-2xs leading-relaxed", failed ? "text-destructive" : "text-muted-foreground")}>
            {detail || status.label}
          </span>
        </span>
        {item.durationMs !== undefined ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDuration(item.durationMs)}</span>
        ) : null}
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-90")}
        />
      </button>
      {open ? (
        <div className="ms-10 me-2 mb-2 space-y-2 text-xs" data-subagent-detail="">
          {facts.length > 0 || item.agentStatus ? (
            <p className="wrap-anywhere text-muted-foreground">
              {[status.label, ...facts].join(" · ")}
              {item.subagentId && !item.subagentId.includes(":") ? <span className="font-mono"> · {item.subagentId}</span> : null}
            </p>
          ) : null}
          {item.prompt.trim() ? (
            <details className="rounded-md border border-border/60 bg-card/50 px-2 py-1">
              <summary className="cursor-pointer py-1 text-muted-foreground pointer-coarse:min-h-11 pointer-coarse:py-3">Prompt</summary>
              <div className="max-h-60 overflow-y-auto pb-1 whitespace-pre-wrap wrap-anywhere text-foreground/85">{item.prompt}</div>
            </details>
          ) : null}
          {result ? (
            <div className="max-h-[min(28rem,60dvh)] overflow-y-auto rounded-md border border-border/60 bg-card/50 p-2 wrap-anywhere">
              <ChatMarkdown text={result} isStreaming={false} headingLevelOffset={3} lineBreaks />
            </div>
          ) : null}
          {item.truncated ? (
            <p className="text-2xs text-muted-foreground italic">The journal cut this; the full text is in the agent's own log.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
