// Same job and name as T3 Code apps/web/src/components/chat/ThreadFindBar.tsx @ e3b35d1b (pattern; MIT,
// see THIRD_PARTY.md). The body is v1's find bar (web/src/components/find-bar.tsx, copied): one row,
// the input fills it, the count sits inline, previous / next / close at the end. Enter goes to the
// next match, Shift+Enter the previous, Escape closes. T3's count text (`formatThreadFindCount`) and
// focus-on-open are kept. The Terminal tab uses the same bar over the mirror (`subject="output"`).
import { useEffect, useRef } from "react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { formatThreadFindCount } from "./threadFind";
import { closeThreadFind, setThreadFindQuery, stepThreadFind, useThreadFind } from "./useThreadFind";

export interface ThreadFindBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** Total matches for the query. */
  count: number;
  /** Zero-based index of the focused match. */
  current: number;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  /** What is searched: "thread" (the timeline) or "output" (the Terminal mirror). */
  subject?: string;
  /** A line under the row, e.g. "Loaded messages only". */
  note?: string | null;
  /** Bumps to re-focus the input when the bar is asked to open while already open. */
  focusRequestId?: number;
  className?: string;
}

export function ThreadFindBar({
  query,
  onQueryChange,
  count,
  current,
  onPrevious,
  onNext,
  onClose,
  subject = "thread",
  note = null,
  focusRequestId = 0,
  className,
}: ThreadFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus (and pop a phone's keyboard) as soon as the bar opens.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequestId]);

  const hasQuery = query.trim().length > 0;
  const countLabel = hasQuery ? formatThreadFindCount(current, count) : "";

  return (
    <div role="search" aria-label={`Find in ${subject}`} data-thread-find-bar="" className={cn("flex flex-col gap-0.5", className)}>
      <div className="flex min-w-0 items-center gap-1">
        <SearchIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          inputMode="search"
          // A phone keyboard has no Shift+Enter; its return key reads "search" and steps to the next hit.
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={200}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              if (e.shiftKey) onPrevious();
              else onNext();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
          placeholder={`Find in ${subject}…`}
          aria-label={`Find in ${subject}`}
          className="h-8 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-sm"
        />
        <span
          aria-live="polite"
          className={cn(
            "shrink-0 whitespace-nowrap px-1 font-mono text-xs tabular-nums",
            hasQuery && count === 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {countLabel}
        </span>
        <Button size="icon-sm" variant="ghost-muted" disabled={count === 0} onClick={onPrevious} aria-label="Previous match">
          <ChevronUpIcon />
        </Button>
        <Button size="icon-sm" variant="ghost-muted" disabled={count === 0} onClick={onNext} aria-label="Next match">
          <ChevronDownIcon />
        </Button>
        <Button size="icon-sm" variant="ghost-muted" onClick={onClose} aria-label="Close find">
          <XIcon />
        </Button>
      </div>
      {note ? <p className="ps-6 text-2xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/** The find bar over the timeline (T19). Searches loaded items only; says so while older pages exist. */
export function TimelineFind({ threadId }: { threadId: string }) {
  const find = useThreadFind(threadId);
  if (!find.isOpen) return null;
  return (
    <div className="absolute inset-x-2 top-2 z-30 rounded-xl border bg-popover px-2 py-1 shadow-md sm:left-auto sm:w-[min(26rem,calc(100%-1rem))]">
      <ThreadFindBar
        query={find.query}
        onQueryChange={setThreadFindQuery}
        count={find.matches.length}
        current={find.activeIndex}
        onPrevious={() => stepThreadFind(-1, find.matches.length)}
        onNext={() => stepThreadFind(1, find.matches.length)}
        onClose={closeThreadFind}
        focusRequestId={find.focusRequestId}
        note={find.partial ? "Loaded messages only" : null}
      />
    </div>
  );
}
