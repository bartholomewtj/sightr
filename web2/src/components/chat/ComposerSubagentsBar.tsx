// T34: the thread's subagents in one place, above the composer (beside the Tasks bar, which sits under it).
//
// Collapsed: a strip with the counts and, for a running agent whose log can be read, what it is doing now.
// A dot on the bar says an agent finished or failed since the list was last open. Tapped: the strip
// expands in place into a list of every agent the thread has run (running first, then newest), with
// Hide finished / Show finished. Tapping an agent opens its own view (`SubagentAgentSheet`: live transcript and details).
// Hidden when the thread has no subagents. The chat's own subagent cards are unchanged.

import type { TurnItem } from "@shared/v2/contracts";
import { BotIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import { useSubagentBarState } from "~/lib/subagentBarState";
import { countSubagents, deriveThreadAgents, subagentCountLine, type ThreadAgent } from "~/lib/subagentGroups";
import { useSubagentActivity } from "~/lib/subagentTranscript";
import { cn } from "~/lib/utils";
import { formatDuration } from "~/session-logic";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import { SubagentAgentSheet } from "./SubagentAgentSheet";
import { subagentName, subagentStatusLabel } from "./SubagentGroup";

function plain(text: string): string {
  return text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
}

/** The one-word state the bar's count shows: the thing most worth knowing. */
function headlineCount(counts: ReturnType<typeof countSubagents>): string {
  if (counts.running > 0) return `${counts.running} running`;
  if (counts.failed > 0) return `${counts.failed} failed`;
  return `${counts.done + counts.stopped} done`;
}

function AgentRow({ threadId, agent, listOpen, onOpen }: { threadId: string; agent: ThreadAgent; listOpen: boolean; onOpen: () => void }) {
  const item = agent.item;
  const running = agent.phase === "running";
  const failed = agent.phase === "failed";
  const status = subagentStatusLabel(item);
  const name = subagentName(item);
  const activity = useSubagentActivity(threadId, item.id, listOpen && running && item.transcript === true);
  const result = plain(item.result ?? "");
  const line = running
    ? activity
      ? `${activity.label}: ${activity.text}`
      : item.progress?.trim() || plain(item.prompt) || "Working…"
    : result || plain(item.prompt);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${name}, ${status.label}`}
        data-subagent-bar-row={agent.key}
        className={cn(
          "flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/20 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11",
          !running && "opacity-70",
        )}
      >
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", status.dotClass, running && "motion-safe:animate-status-pulse")} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-xs font-medium text-foreground">{name}</span>
            <span className={cn("shrink-0 text-3xs", failed ? "text-destructive" : "text-muted-foreground")}>{status.label}</span>
          </span>
          {line ? <span className={cn("block truncate text-2xs", failed ? "text-destructive" : "text-muted-foreground")}>{line}</span> : null}
        </span>
        {item.durationMs !== undefined ? (
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">{formatDuration(item.durationMs)}</span>
        ) : null}
      </button>
    </li>
  );
}

export const ComposerSubagentsBar = memo(function ComposerSubagentsBar({
  threadId,
  items,
}: {
  readonly threadId: string;
  readonly items: Readonly<Record<string, TurnItem>> | undefined;
}) {
  const agents = useMemo(() => deriveThreadAgents(items), [items]);
  const newestItemAt = useMemo(() => {
    if (!items) return null;
    let newest: number | null = null;
    for (const item of Object.values(items)) {
      const at = item.updatedAt ?? item.createdAt;
      if (newest === null || at > newest) newest = at;
    }
    return newest;
  }, [items]);
  const bar = useSubagentBarState(threadId, agents, newestItemAt);
  const [expanded, setExpanded] = useState(false);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const { visible, markSeen } = bar;

  // While the list is open, what finishes is seen as it happens.
  useEffect(() => {
    if (expanded) markSeen();
  }, [expanded, markSeen, agents]);
  useEffect(() => {
    if (visible.length === 0) {
      setExpanded(false);
      setDetailKey(null);
    }
  }, [visible.length]);

  const lead = visible.find((a) => a.phase === "running" && a.item.transcript === true);
  const leadActivity = useSubagentActivity(threadId, lead?.item.id ?? "", lead !== undefined);

  if (visible.length === 0) return null;
  const counts = countSubagents(visible.map((a) => a.item));
  const line = subagentCountLine(counts);
  const headline = leadActivity ? `${leadActivity.label}: ${leadActivity.text}` : line;
  const detail = detailKey === null ? null : (visible.find((a) => a.key === detailKey) ?? agents.find((a) => a.key === detailKey) ?? null);

  return (
    <>
      <ComposerBanner.Root density="comfortable" data-composer-shoulder-tab data-composer-subagents-bar="true">
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-expanded={expanded}
          aria-label={`Subagents: ${line}${bar.unseen.length > 0 ? `. ${bar.unseen.length} finished since you last looked` : ""}`}
          className="pointer-coarse:min-h-11"
          data-composer-subagents-toggle="true"
          onClick={() => setExpanded((v) => !v)}
        >
          <ComposerBanner.Icon className="relative">
            <BotIcon />
            {bar.unseen.length > 0 ? (
              <span
                data-subagents-unseen={bar.unseenFailed ? "failed" : "done"}
                className={cn("absolute top-0.5 right-1 size-2 rounded-full ring-2 ring-card", bar.unseenFailed ? "bg-destructive" : "bg-info")}
              />
            ) : null}
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="shrink-0 text-muted-foreground">Subagents</span>
            <span className="min-w-0 flex-1 truncate text-left font-medium text-foreground/80" data-composer-subagents-line="true">
              {headline}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count
              className={counts.running === 0 && counts.failed === 0 ? "text-success" : counts.running === 0 ? "text-destructive" : undefined}
              data-composer-subagents-count="true"
            >
              {headlineCount(counts)}
            </ComposerBanner.Count>
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {expanded ? (
          <div className="mt-1 border-t border-border/50 pt-1" data-composer-subagents-list="true">
            <div className="flex items-center justify-between gap-2 px-2 pb-0.5">
              <span className="min-w-0 truncate text-2xs text-muted-foreground">{line}</span>
              {bar.finishedCount > 0 ? (
                <Button size="xs" variant="ghost" onClick={bar.toggleHideFinished} aria-pressed={bar.hideFinished} data-subagents-hide-finished="">
                  {bar.hideFinished ? `Show finished (${bar.finishedCount})` : "Hide finished"}
                </Button>
              ) : null}
            </div>
            {bar.listed.length === 0 ? (
              <p className="px-2 py-2 text-2xs text-muted-foreground" data-subagents-none-running="">
                Nothing is running. Finished agents are hidden.
              </p>
            ) : null}
            <ComposerBanner.Scroll className="overflow-x-hidden">
              <ul role="list" aria-label="Subagents" className="grid grid-cols-[minmax(0,1fr)] gap-px">
                {bar.listed.map((agent) => (
                  <AgentRow key={agent.key} threadId={threadId} agent={agent} listOpen={expanded} onOpen={() => setDetailKey(agent.key)} />
                ))}
              </ul>
            </ComposerBanner.Scroll>
          </div>
        ) : null}
      </ComposerBanner.Root>
      <SubagentAgentSheet threadId={threadId} agent={detail} onBack={() => setDetailKey(null)} />
    </>
  );
});
