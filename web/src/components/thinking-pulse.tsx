import { useEffect, useState } from "react";
import { Brain } from "lucide-react";

import { elapsed } from "@/lib/thinking-pulse";

/** Live thinking tell above the composer: a timer, plus the last dump lines when Show thinking is on. */
export function ThinkingPulse({ startedAt, snip }: { startedAt: number; snip: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const clock = elapsed(now - startedAt);
  return (
    <div
      data-testid="thinking-pulse"
      role="status"
      aria-live="polite"
      className="mx-3 mb-1 text-xs text-muted-foreground"
    >
      <div className="flex items-center gap-1.5">
        <Brain className="size-3.5 shrink-0" />
        <span className="animate-pulse tabular-nums">Thinking {clock}</span>
      </div>
      {snip ? (
        <div className="mt-1 max-h-24 overflow-hidden border-l-2 border-border pl-2.5 font-mono text-[11px] leading-snug italic whitespace-pre-wrap">
          {snip}
        </div>
      ) : null}
    </div>
  );
}
