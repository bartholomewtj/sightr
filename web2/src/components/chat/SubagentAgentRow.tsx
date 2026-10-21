// T34/T35: one agent's row, shared by the card above the composer (running agents) and the header sheet (all of them).

import { useSubagentActivity } from "~/lib/subagentTranscript";
import type { ThreadAgent } from "~/lib/subagentGroups";
import { cn } from "~/lib/utils";
import { formatDuration } from "~/session-logic";
import { subagentName, subagentStatusLabel } from "./SubagentGroup";

function plain(text: string): string {
  return text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
}

export function SubagentAgentRow({ threadId, agent, listOpen, onOpen }: { threadId: string; agent: ThreadAgent; listOpen: boolean; onOpen: () => void }) {
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
