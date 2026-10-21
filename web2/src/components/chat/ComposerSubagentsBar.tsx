// T34, changed by T35: the card above the composer shows only the thread's RUNNING subagents, and only
// while at least one is running (it is gone the moment none is). Every agent of the thread, finished
// ones included, lives behind the header's subagents button (`ThreadSubagentsButton`).
//
// Collapsed: a strip with the count and what the lead running agent is doing now. Tapped: it expands in
// place into a list of the running agents. Tapping one opens its own view (`SubagentAgentSheet`: live
// transcript and details); if it finishes while you watch, the view stays. The chat's own subagent cards
// are unchanged.

import type { TurnItem } from "@shared/v2/contracts";
import { BotIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import { deriveThreadAgents } from "~/lib/subagentGroups";
import { useSubagentActivity } from "~/lib/subagentTranscript";
import { ComposerBanner } from "./ComposerBanner";
import { SubagentAgentRow } from "./SubagentAgentRow";
import { SubagentAgentSheet } from "./SubagentAgentSheet";

export const ComposerSubagentsBar = memo(function ComposerSubagentsBar({
  threadId,
  items,
}: {
  readonly threadId: string;
  readonly items: Readonly<Record<string, TurnItem>> | undefined;
}) {
  const agents = useMemo(() => deriveThreadAgents(items), [items]);
  const running = useMemo(() => agents.filter((a) => a.phase === "running"), [agents]);
  const [expanded, setExpanded] = useState(false);
  const [detailKey, setDetailKey] = useState<string | null>(null);

  useEffect(() => {
    if (running.length === 0) setExpanded(false);
  }, [running.length]);
  // Another thread: nothing of this one stays open.
  useEffect(() => {
    setExpanded(false);
    setDetailKey(null);
  }, [threadId]);

  const lead = running.find((a) => a.item.transcript === true);
  const leadActivity = useSubagentActivity(threadId, lead?.item.id ?? "", lead !== undefined);

  // The open agent is looked up among all agents: it stays on screen after it finishes.
  const detail = detailKey === null ? null : (agents.find((a) => a.key === detailKey) ?? null);
  const line = `${running.length} running`;
  const headline = leadActivity ? `${leadActivity.label}: ${leadActivity.text}` : line;

  return (
    <>
      {running.length > 0 ? (
        <ComposerBanner.Root density="comfortable" data-composer-shoulder-tab data-composer-subagents-bar="true">
          <ComposerBanner.Row
            render={<button type="button" />}
            aria-expanded={expanded}
            aria-label={`Subagents: ${line}`}
            className="pointer-coarse:min-h-11"
            data-composer-subagents-toggle="true"
            onClick={() => setExpanded((v) => !v)}
          >
            <ComposerBanner.Icon>
              <BotIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              <span className="shrink-0 text-muted-foreground">Subagents</span>
              <span className="min-w-0 flex-1 truncate text-left font-medium text-foreground/80" data-composer-subagents-line="true">
                {headline}
              </span>
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <ComposerBanner.Count data-composer-subagents-count="true">{line}</ComposerBanner.Count>
              <ComposerBanner.ToggleIcon expanded={expanded} />
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
          {expanded ? (
            <div className="mt-1 border-t border-border/50 pt-1" data-composer-subagents-list="true">
              <ComposerBanner.Scroll className="overflow-x-hidden">
                <ul role="list" aria-label="Subagents" className="grid grid-cols-[minmax(0,1fr)] gap-px">
                  {running.map((agent) => (
                    <SubagentAgentRow key={agent.key} threadId={threadId} agent={agent} listOpen={expanded} onOpen={() => setDetailKey(agent.key)} />
                  ))}
                </ul>
              </ComposerBanner.Scroll>
            </div>
          ) : null}
        </ComposerBanner.Root>
      ) : null}
      <SubagentAgentSheet threadId={threadId} agent={detail} onBack={() => setDetailKey(null)} />
    </>
  );
});
