// T32: a run's subagents as one card. Sightr-only (T3 draws one `SubagentTimelineLink` per agent).
//
// The card says how many agents are running or done; each agent is a row that opens to its facts, the
// brief it was given, and its report as a summary card. The agents arrive already merged per agent id
// (`lib/subagentGroups.ts`), so a check-on call no longer shows as a bare id with nothing in it.
// Phone pass: rows are 44 px targets on a coarse pointer; nothing here needs hover.

import type { TurnItem } from "@shared/v2/contracts";
import { BotIcon, ChevronRightIcon, ListTreeIcon } from "lucide-react";
import { useState } from "react";

import {
  countSubagents,
  subagentCountLine,
  subagentPhase,
  type SubagentItem,
  type SubagentPhase,
} from "~/lib/subagentGroups";
import { useSubagentActivity } from "~/lib/subagentTranscript";
import { cn } from "~/lib/utils";
import { formatDuration } from "~/session-logic";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { useOpenFileThread } from "../right-panel/OpenFileLink";
import { MessageCopyButton } from "./MessageCopyButton";
import { SubagentTranscriptSheet } from "./SubagentTranscriptSheet";

const PHASE_VISUALS: Record<SubagentPhase, { dotClass: string; label: string }> = {
  running: { dotClass: "bg-info", label: "Running" },
  done: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  stopped: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

const STATUS_LABELS: Record<TurnItem["status"], string> = {
  pending: "Queued",
  running: "Running",
  waiting: "Waiting",
  idle: "Idle · resumable",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

/**
 * The status an agent row shows. The harness's own word wins where it says more than the call's
 * status: a background launch completes the call while the agent keeps running.
 */
export function subagentStatusLabel(item: SubagentItem): { label: string; dotClass: string } {
  const phase = subagentPhase(item);
  const word = item.agentStatus?.toLowerCase();
  if (phase === "running") {
    if (word === "async_launched" || word === "background") return { label: "Running in the background", dotClass: PHASE_VISUALS.running.dotClass };
    if (word === "running" && item.status !== "running") return { label: "Still running", dotClass: PHASE_VISUALS.running.dotClass };
    return { label: STATUS_LABELS[item.status] === "Completed" ? "Running" : STATUS_LABELS[item.status], dotClass: PHASE_VISUALS.running.dotClass };
  }
  if (phase === "done") return { label: "Completed", dotClass: PHASE_VISUALS.done.dotClass };
  return PHASE_VISUALS[phase];
}

function plainDetail(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "sonnet · 12k tokens · 3 tools" from what the harness reported. */
export function subagentFacts(item: SubagentItem): string[] {
  const facts: string[] = [];
  if (item.model) facts.push(item.model);
  if (item.tokens) facts.push(/^\d+$/.test(item.tokens) ? `${Number(item.tokens).toLocaleString()} tokens` : `${item.tokens} tokens`);
  if (item.toolUses !== undefined) facts.push(`${item.toolUses} ${item.toolUses === 1 ? "tool" : "tools"}`);
  return facts;
}

/** The agent's name: its task description, else "Subagent" (never the bare id). */
export function subagentName(item: SubagentItem): string {
  const title = item.title?.trim();
  const id = item.subagentId && !item.subagentId.includes(":") ? item.subagentId : "";
  if (title && title !== id) return title;
  return "Subagent";
}

export function SubagentGroupRow({ agents }: { agents: readonly SubagentItem[] }) {
  const counts = countSubagents(agents);
  return (
    <section
      data-v2-item-type="subagent"
      data-subagent-group=""
      aria-label="Subagents"
      className="min-w-0 rounded-lg border border-border/60 bg-card/30"
    >
      <header className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-xs">
        <BotIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{agents.length === 1 ? "Subagent" : "Subagents"}</span>
        <span className="min-w-0 truncate text-muted-foreground" data-subagent-counts="">
          {subagentCountLine(counts)}
        </span>
      </header>
      <ul className="divide-y divide-border/30">
        {agents.map((agent) => (
          <li key={agent.id} className="min-w-0">
            <SubagentAgentRow item={agent} defaultOpen={agents.length === 1 && subagentPhase(agent) === "running"} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SubagentAgentRow({ item, defaultOpen }: { item: SubagentItem; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [watching, setWatching] = useState(false);
  const threadId = useOpenFileThread();
  const phase = subagentPhase(item);
  const status = subagentStatusLabel(item);
  const failed = phase === "failed";
  const running = phase === "running";
  const result = item.result?.trim() ?? "";
  const name = subagentName(item);
  const facts = subagentFacts(item);
  // T33: a running agent whose log can be opened says what it is doing now, from that log.
  const canWatch = item.transcript === true && threadId !== null;
  const activity = useSubagentActivity(threadId, item.id, canWatch && running);
  // The row's second line: what it is doing now, else the report's first words, else the brief's.
  const line = running
    ? activity
      ? `${activity.label}: ${activity.text}`
      : item.progress?.trim() || plainDetail(item.prompt) || "Working…"
    : result
      ? plainDetail(result)
      : plainDetail(item.prompt);
  const id = item.subagentId && !item.subagentId.includes(":") ? item.subagentId : null;
  return (
    <div data-subagent-agent={id ?? item.id}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${name}, ${status.label}`}
        onClick={() => setOpen((v) => !v)}
        className="group/subagent flex w-full min-w-0 cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 pointer-coarse:min-h-11"
      >
        <span
          aria-hidden
          className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted"
        >
          <BotIcon className="size-3.5 text-muted-foreground" />
          <span
            className={cn(
              "absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-background",
              status.dotClass,
              running && "motion-safe:animate-status-pulse",
            )}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-xs font-medium text-foreground">{name}</span>
            <span className={cn("shrink-0 text-3xs", failed ? "text-destructive" : "text-muted-foreground")}>{status.label}</span>
          </span>
          {line ? (
            <span className={cn("block truncate text-2xs leading-relaxed", failed ? "text-destructive" : "text-muted-foreground")}>{line}</span>
          ) : null}
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
        <SubagentDetail
          item={item}
          status={status.label}
          facts={facts}
          id={id}
          result={result}
          failed={failed}
          running={running}
          onWatch={canWatch ? () => setWatching(true) : null}
        />
      ) : null}
      {canWatch ? (
        <SubagentTranscriptSheet
          threadId={threadId}
          itemId={item.id}
          title={name}
          statusLabel={status.label}
          running={running}
          open={watching}
          onClose={() => setWatching(false)}
        />
      ) : null}
    </div>
  );
}

/** A block clamped to a few lines with a Show all toggle; short text shows whole with no toggle. */
function Clamped({ children, long, label }: { children: React.ReactNode; long: boolean; label: string }) {
  const [all, setAll] = useState(false);
  return (
    <div>
      <div className={cn("overflow-hidden", !all && long && "max-h-24 [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}>{children}</div>
      {long ? (
        <button
          type="button"
          aria-expanded={all}
          aria-label={all ? `Show less of the ${label}` : `Show all of the ${label}`}
          onClick={() => setAll((v) => !v)}
          className="mt-1 text-2xs text-muted-foreground underline-offset-2 hover:underline pointer-coarse:min-h-11 pointer-coarse:py-3"
        >
          {all ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}

function SubagentDetail(props: {
  item: SubagentItem;
  status: string;
  facts: string[];
  id: string | null;
  result: string;
  failed: boolean;
  running: boolean;
  /** Opens the agent's own conversation; null when its log cannot be opened. */
  onWatch: (() => void) | null;
}) {
  const { item, status, facts, id, result, failed, running, onWatch } = props;
  const prompt = item.prompt.trim();
  const longBrief = prompt.length > 240 || prompt.split("\n").length > 4;
  const longResult = result.length > 420 || result.split("\n").length > 8;
  return (
    <div className="space-y-2.5 px-3 pb-3 ps-11 text-xs" data-subagent-detail="">
      <p className="wrap-anywhere text-muted-foreground">
        {[status, ...facts].join(" · ")}
        {id ? <span className="font-mono"> · {id}</span> : null}
      </p>
      {onWatch ? (
        <Button size="sm" variant="outline" onClick={onWatch} className="pointer-coarse:min-h-11" data-subagent-watch="">
          <ListTreeIcon /> {running ? "Watch live" : "Open transcript"}
        </Button>
      ) : null}
      {prompt ? (
        <section aria-label="Brief" data-subagent-brief="">
          <h4 className="mb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">Brief</h4>
          <Clamped long={longBrief} label="brief">
            <p className="whitespace-pre-wrap wrap-anywhere text-foreground/85">{item.prompt}</p>
          </Clamped>
        </section>
      ) : null}
      {running && item.progress?.trim() ? (
        <p className="text-muted-foreground" data-subagent-progress="">
          Now: {item.progress}
        </p>
      ) : null}
      {result ? (
        <section
          aria-label={failed ? "Error" : "Result"}
          data-subagent-result=""
          className={cn("rounded-md border bg-card/60 p-2", failed ? "border-destructive/40" : "border-border/60")}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <h4 className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">{failed ? "Error" : "Result"}</h4>
            <MessageCopyButton text={result} label="Copy the result" />
          </div>
          <Clamped long={longResult} label="result">
            <div className={cn("wrap-anywhere", failed && "text-destructive")}>
              <ChatMarkdown text={result} isStreaming={false} headingLevelOffset={3} lineBreaks />
            </div>
          </Clamped>
        </section>
      ) : !prompt ? (
        // A call that only asks for an agent's state carries no brief; with no report yet, say so rather
        // than open to a blank gap.
        <p className="text-2xs text-muted-foreground italic" data-subagent-empty="">
          {running
            ? "Waiting for this agent's report. It shows here when the agent finishes."
            : "The journal has no brief or report for this agent."}
        </p>
      ) : running ? (
        <p className="text-2xs text-muted-foreground italic" data-subagent-empty="">
          No report yet. It shows here when the agent finishes.
        </p>
      ) : null}
      {item.truncated ? (
        <p className="text-2xs text-muted-foreground italic">The journal cut this; the full text is in the agent's own log.</p>
      ) : null}
    </div>
  );
}
