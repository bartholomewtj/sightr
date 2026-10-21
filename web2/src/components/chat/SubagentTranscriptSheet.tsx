// T33: a subagent's own conversation, opened from its row in the subagent card. Read-only.
//
// Phone: a tall bottom sheet that holds one history entry (the T13 rule: Back closes it). Desktop: a side
// sheet. The body mounts only while open, so nothing polls for a closed view. The items arrive in the
// thread's own item shape (`lib/subagentTranscript.ts`); a tool call is a one-line row that opens to the
// same detail the main timeline shows (`ToolItemDetail`). While the agent runs the view re-reads every 2 s
// and follows the end; scrolling up leaves follow mode and a button brings it back.

import type { TurnItem } from "@shared/v2/contracts";
import { ArrowDownIcon, BotIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { useLayout } from "@/hooks/useLayout";
import { transcriptUnavailableText, useSubagentTranscript } from "~/lib/subagentTranscript";
import { cn } from "~/lib/utils";
import { dynamicToolDisplayName, providerErrorPresentation, todoListLabel, webSearchLabel } from "~/session-logic";
import ChatMarkdown from "../ChatMarkdown";
import { useSheetHistory } from "../sheetHistory";
import { Button } from "../ui/button";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { ToolItemDetail } from "./ToolItemDetail";

export interface SubagentTranscriptSheetProps {
  threadId: string;
  /** Any item of the agent: the bridge finds the rest by agent id. */
  itemId: string;
  title: string;
  statusLabel: string;
  running: boolean;
  open: boolean;
  onClose: () => void;
}

export function SubagentTranscriptSheet(props: SubagentTranscriptSheetProps) {
  const { open, onClose } = props;
  const layout = useLayout();
  useSheetHistory(open, onClose);
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetPopup
        side={layout === "desktop" ? "right" : "bottom"}
        showCloseButton={false}
        className={cn(layout === "desktop" ? "max-w-2xl sm:w-[40rem]" : "h-[92dvh] max-h-[92dvh] rounded-t-2xl")}
        data-subagent-transcript=""
      >
        <SheetTitle className="sr-only">{props.title} transcript</SheetTitle>
        <TranscriptBody {...props} />
      </SheetPopup>
    </Sheet>
  );
}

/** One line for a tool call, by kind: what it did, in a few words. */
export function toolLabel(item: TurnItem): { verb: string; text: string } | null {
  switch (item.type) {
    case "command_execution":
      return { verb: "Ran", text: item.input.split("\n")[0] ?? "" };
    case "file_change":
      return { verb: "Edited", text: item.fileName };
    case "file_search":
      return { verb: "Searched", text: item.pattern ?? "files" };
    case "web_search":
      return { verb: webSearchLabel(item), text: (item.patterns ?? []).join(", ") };
    case "dynamic_tool": {
      const arg = typeof item.input === "string" ? item.input : "";
      return { verb: dynamicToolDisplayName(item.toolName) ?? "Tool", text: arg };
    }
    default:
      return null;
  }
}

function ToolRow({ item }: { item: TurnItem }) {
  const [open, setOpen] = useState(false);
  const label = toolLabel(item);
  if (!label) return null;
  const failed = item.status === "failed";
  const running = item.status === "running";
  return (
    <div data-transcript-item={item.type}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/20 pointer-coarse:min-h-11"
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            failed ? "bg-destructive" : running ? "bg-info motion-safe:animate-status-pulse" : "bg-muted-foreground/50",
          )}
        />
        <span className="shrink-0 font-medium text-foreground/90">{label.verb}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">{label.text}</span>
        <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="ms-4 mb-1.5">
          <ToolItemDetail item={item} />
        </div>
      ) : null}
    </div>
  );
}

function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function TranscriptItem({ item, first }: { item: TurnItem; first: boolean }) {
  switch (item.type) {
    case "user_message":
      return (
        <details className="rounded-md border border-border/60 bg-card/50 px-2 py-1" data-transcript-item="user_message" open={first && item.text.length < 400}>
          <summary className="cursor-pointer py-1 text-xs text-muted-foreground pointer-coarse:min-h-11 pointer-coarse:py-3">
            {first ? "Brief" : "Message"} · {firstLine(item.text, 80)}
          </summary>
          <p className="pb-1 text-xs whitespace-pre-wrap wrap-anywhere text-foreground/85">{item.text}</p>
        </details>
      );
    case "assistant_message":
      return item.text.trim() ? (
        <div className="px-1 text-sm wrap-anywhere" data-transcript-item="assistant_message">
          <ChatMarkdown text={item.text} isStreaming={false} headingLevelOffset={3} lineBreaks />
        </div>
      ) : null;
    case "reasoning":
      return item.text.trim() ? (
        <details className="px-2 text-xs text-muted-foreground" data-transcript-item="reasoning">
          <summary className="cursor-pointer py-1 pointer-coarse:min-h-11 pointer-coarse:py-3">Thinking · {firstLine(item.text, 80)}</summary>
          <p className="pb-1 whitespace-pre-wrap wrap-anywhere">{item.text}</p>
        </details>
      ) : null;
    case "todo_list":
      return (
        <p className="px-2 text-xs text-muted-foreground" data-transcript-item="todo_list">
          {todoListLabel(item)}
        </p>
      );
    case "error": {
      const { label, detail } = providerErrorPresentation(item);
      return (
        <p className="px-2 text-xs text-destructive wrap-anywhere" data-transcript-item="error">
          {label}: {detail}
        </p>
      );
    }
    default:
      return <ToolRow item={item} />;
  }
}

function TranscriptBody({ threadId, itemId, title, statusLabel, running, onClose }: SubagentTranscriptSheetProps) {
  const { view, loading, error } = useSubagentTranscript(threadId, itemId, { enabled: true, live: running });
  const scroller = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const count = view?.items.length ?? 0;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (following && el) el.scrollTop = el.scrollHeight;
  }, [count, view?.size, following]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };
  const jump = () => {
    setFollowing(true);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <BotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          <p className="text-2xs text-muted-foreground" data-transcript-status="">
            {statusLabel}
            {running ? " · live" : ""}
          </p>
        </div>
        <Button size="icon" variant="ghost" aria-label="Close the transcript" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="h-full space-y-1.5 overflow-y-auto overscroll-y-contain px-2 py-3" data-transcript-scroll="">
          {view?.cutHead ? (
            <p className="px-1 pb-1 text-2xs text-muted-foreground italic">Earlier steps are cut; this starts partway through the agent's log.</p>
          ) : null}
          {view?.items.map((item, i) => <TranscriptItem key={item.id} item={item} first={i === 0} />)}
          {loading && !view ? <p className="px-2 text-xs text-muted-foreground">Loading…</p> : null}
          {error && !view ? (
            <p className="px-2 text-xs text-muted-foreground" data-transcript-error="">
              {error.unavailable ? transcriptUnavailableText(error.reason) : "The agent's log could not be loaded. Retrying."}
            </p>
          ) : null}
          {view && view.items.length === 0 ? <p className="px-2 text-xs text-muted-foreground">Nothing in the agent's log yet.</p> : null}
        </div>
        {!following && view ? (
          <Button size="sm" variant="secondary" className="absolute bottom-2 left-1/2 -translate-x-1/2 shadow-md" onClick={jump} data-transcript-jump="">
            <ArrowDownIcon /> {running ? "Follow live" : "Jump to end"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
