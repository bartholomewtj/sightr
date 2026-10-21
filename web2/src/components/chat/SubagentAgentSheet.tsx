// T34: one subagent in a view of its own, opened from the bar's list. Two tabs: the live transcript and the
// details (facts, brief, result card). A running agent with a log opens on the transcript, anything else on
// the details. The back arrow returns to the list (the bar's panel stays open under the sheet).
// Phone: a tall bottom sheet that holds one history entry, so Back closes it; desktop: a side sheet.

import { ArrowLeftIcon, BotIcon } from "lucide-react";
import { useState } from "react";

import { useLayout } from "@/hooks/useLayout";
import type { ThreadAgent } from "~/lib/subagentGroups";
import { cn } from "~/lib/utils";
import { useSheetHistory } from "../sheetHistory";
import { Button } from "../ui/button";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { SubagentDetail, subagentFacts, subagentName, subagentStatusLabel } from "./SubagentGroup";
import { TranscriptPane } from "./SubagentTranscriptSheet";

type Tab = "transcript" | "details";

export function SubagentAgentSheet(props: { threadId: string; agent: ThreadAgent | null; onBack: () => void }) {
  const { agent, onBack } = props;
  const layout = useLayout();
  useSheetHistory(agent !== null, onBack);
  return (
    <Sheet open={agent !== null} onOpenChange={(next) => !next && onBack()}>
      <SheetPopup
        side={layout === "desktop" ? "right" : "bottom"}
        showCloseButton={false}
        className={cn(layout === "desktop" ? "max-w-2xl sm:w-[40rem]" : "h-[92dvh] max-h-[92dvh] rounded-t-2xl")}
        data-subagent-agent-sheet=""
      >
        {agent ? <AgentView threadId={props.threadId} agent={agent} onBack={onBack} /> : null}
      </SheetPopup>
    </Sheet>
  );
}

function AgentView({ threadId, agent, onBack }: { threadId: string; agent: ThreadAgent; onBack: () => void }) {
  const item = agent.item;
  const running = agent.phase === "running";
  const canWatch = item.transcript === true;
  const [tab, setTab] = useState<Tab>(canWatch && running ? "transcript" : "details");
  const status = subagentStatusLabel(item);
  const name = subagentName(item);
  const id = item.subagentId && !item.subagentId.includes(":") ? item.subagentId : null;
  const result = item.result?.trim() ?? "";
  return (
    <div className="flex min-h-0 flex-1 flex-col pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <SheetTitle className="sr-only">{name}</SheetTitle>
      <header className="flex items-center gap-1 border-b border-border/60 px-2 py-2">
        <Button size="icon" variant="ghost" aria-label="Back to subagents" onClick={onBack} data-subagent-back="">
          <ArrowLeftIcon />
        </Button>
        <BotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{name}</h2>
          <p className="text-2xs text-muted-foreground" data-agent-status="">
            {status.label}
            {running && canWatch ? " · live" : ""}
          </p>
        </div>
      </header>
      {canWatch ? (
        <div role="tablist" aria-label="Subagent view" className="flex gap-1 border-b border-border/40 px-2 py-1.5">
          {(["transcript", "details"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              data-agent-tab={t}
              className={cn(
                "rounded-md px-3 py-1 text-xs transition-colors pointer-coarse:min-h-11",
                tab === t ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/40",
              )}
            >
              {t === "transcript" ? "Transcript" : "Details"}
            </button>
          ))}
        </div>
      ) : null}
      {canWatch && tab === "transcript" ? (
        <TranscriptPane threadId={threadId} itemId={item.id} running={running} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          <SubagentDetail
            item={item}
            status={status.label}
            facts={subagentFacts(item)}
            id={id}
            result={result}
            failed={agent.phase === "failed"}
            running={running}
            onWatch={null}
            flush
          />
          {!canWatch ? (
            <p className="px-3 pb-3 text-2xs text-muted-foreground italic" data-agent-no-transcript="">
              This agent's own log isn't available, so there is no live transcript.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
