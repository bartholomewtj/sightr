// T35: every subagent this thread has run, behind one button in the thread header.
//
// The button is absent while the thread has no subagents. It shows how many are running (a badge) and a dot
// when one finished or failed since the sheet was last open (red for a failure; the memory is per thread, per
// device: `useSubagentBarState`). Tapped, it opens a sheet (bottom on a phone, side on desktop) listing all
// of the thread's loaded agents, running first and then newest, finished ones dimmed. A row opens that agent's
// own view (`SubagentAgentSheet`) over the list; its back arrow returns here.

import { BotIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useLayout } from "@/hooks/useLayout";
import { useThread } from "@/stream/stores";
import { newestItemAtOf, useSubagentBarState } from "~/lib/subagentBarState";
import { countSubagents, deriveThreadAgents, subagentCountLine } from "~/lib/subagentGroups";
import { cn } from "~/lib/utils";
import { useSheetHistory } from "../sheetHistory";
import { Button } from "../ui/button";
import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "../ui/sheet";
import { SubagentAgentRow } from "./SubagentAgentRow";
import { SubagentAgentSheet } from "./SubagentAgentSheet";

export function ThreadSubagentsButton({ threadId }: { threadId: string }) {
  const items = useThread(threadId)?.items;
  const layout = useLayout();
  const agents = useMemo(() => deriveThreadAgents(items), [items]);
  const newestItemAt = useMemo(() => newestItemAtOf(items), [items]);
  const { unseen, unseenFailed, markSeen } = useSubagentBarState(threadId, agents, newestItemAt);
  const [open, setOpen] = useState(false);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  useSheetHistory(open, () => setOpen(false));

  // Another thread: the sheet does not follow.
  useEffect(() => {
    setOpen(false);
    setDetailKey(null);
  }, [threadId]);
  // While the sheet is open, what finishes is seen as it happens.
  useEffect(() => {
    if (open) markSeen();
  }, [open, markSeen, agents]);

  if (agents.length === 0) return null;
  const counts = countSubagents(agents.map((a) => a.item));
  const line = subagentCountLine(counts);
  const detail = detailKey === null ? null : (agents.find((a) => a.key === detailKey) ?? null);
  const label = `Subagents: ${line}${unseen.length > 0 ? `. ${unseen.length} finished since you last looked` : ""}`;

  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost-muted"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Subagents"
        data-thread-subagents-button=""
        className={cn("relative", open && "bg-accent text-foreground")}
        onClick={() => setOpen((v) => !v)}
      >
        <BotIcon />
        {counts.running > 0 ? (
          <span
            data-subagents-running={counts.running}
            className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-3xs leading-4 font-medium text-primary-foreground tabular-nums"
          >
            {counts.running}
          </span>
        ) : null}
        {unseen.length > 0 ? (
          <span
            data-subagents-unseen={unseenFailed ? "failed" : "done"}
            className={cn("absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-background", unseenFailed ? "bg-destructive" : "bg-info")}
          />
        ) : null}
      </Button>
      <Sheet open={open} onOpenChange={(next) => !next && setOpen(false)}>
        <SheetPopup
          side={layout === "desktop" ? "right" : "bottom"}
          className={cn(layout === "desktop" ? "max-w-2xl sm:w-[32rem]" : "h-[80dvh] max-h-[80dvh] rounded-t-2xl")}
          data-thread-subagents-sheet=""
        >
          <div className="flex min-h-0 flex-1 flex-col pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <header className="flex items-center gap-2 border-b border-border/60 px-4 py-3 pe-12">
              <BotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-sm font-medium">Subagents</SheetTitle>
                <SheetDescription className="text-2xs" data-thread-subagents-line="">
                  {line}
                </SheetDescription>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-1.5">
              <ul role="list" aria-label="All subagents" className="grid grid-cols-[minmax(0,1fr)] gap-px">
                {agents.map((agent) => (
                  <SubagentAgentRow key={agent.key} threadId={threadId} agent={agent} listOpen={open} onOpen={() => setDetailKey(agent.key)} />
                ))}
              </ul>
            </div>
          </div>
        </SheetPopup>
      </Sheet>
      <SubagentAgentSheet threadId={threadId} agent={detail} onBack={() => setDetailKey(null)} />
    </>
  );
}
