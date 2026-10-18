// Sightr code (T29, optional last piece). A review comment inside a sent message, as a collapsed card: a header chip
// `path:12-14 new`, and on a tap the quoted lines tinted as the Diff tab tints them, with the note below. The message is
// still the plain text `formatReviewBlock` wrote (an agent reads it as is); this only draws it. No diff renderer and
// no lookup of the live diff: the card shows what the block says. Text that does not parse as a block never gets here.
import { ChevronRightIcon, MessageSquareQuoteIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import type { ReviewBlock } from "@/lib/reviewCommentContext";

const TINT = { "+": "text-[var(--ok)] bg-[color-mix(in_srgb,var(--ok)_14%,transparent)]", "-": "text-[var(--warn)] bg-[color-mix(in_srgb,var(--warn)_14%,transparent)]" } as const;

export function ReviewCommentCard({ block }: { block: ReviewBlock }) {
  const [open, setOpen] = useState(false);
  const range = block.end > block.start ? `${block.start}-${block.end}` : `${block.start}`;
  return (
    <div data-review-card="" className="my-1 overflow-hidden rounded-lg border bg-card text-card-foreground">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs pointer-coarse:min-h-11"
      >
        <ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <MessageSquareQuoteIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 break-all font-mono">
          {block.path}:{range}
        </span>
        <span className="shrink-0 text-muted-foreground">{block.side}</span>
        {block.outdated ? <span className="shrink-0 rounded-full border border-[var(--warn)] px-1.5 text-3xs text-[var(--warn)]">outdated</span> : null}
      </button>
      {open ? (
        <div className="border-t">
          <pre className="overflow-x-auto font-mono text-xs leading-5" aria-label="Quoted lines">
            {block.quote.map((line, i) => (
              <div key={i} className={cn("px-2 whitespace-pre-wrap break-all", TINT[line[0] as "+" | "-"])}>
                {line === "" ? " " : line}
              </div>
            ))}
          </pre>
          <p className="whitespace-pre-wrap border-t px-2 py-1.5 text-sm wrap-anywhere">{block.note}</p>
        </div>
      ) : null}
    </div>
  );
}
