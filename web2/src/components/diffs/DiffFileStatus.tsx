// Pattern from T3 Code apps/web/src/components/diffs/DiffFileStatus.tsx @ 3a4d118a518a (MIT, see THIRD_PARTY.md).
// T3's is a retry/partial-preview icon with a hover tooltip. A phone has no hover, so Sightr's is a visible
// letter chip for the kind of change (A, M, D, R, ?) with the word for a screen reader; the error, truncated
// and retry states are drawn in the file's body (`DiffPanel.tsx`), where they have room for a sentence.
import type { ReviewFileKind } from "@shared/v2/review";

import { cn } from "~/lib/utils";

import { KIND_CHIP } from "./diffFileActions";

const TONE: Record<ReviewFileKind, string> = {
  added: "border-success/30 bg-success/8 text-success",
  modified: "border-border text-muted-foreground",
  deleted: "border-destructive/25 bg-destructive/8 text-destructive",
  renamed: "border-info/30 bg-info/8 text-info",
  untracked: "border-border text-muted-foreground",
};

export function DiffFileStatus({ kind, className }: { kind: ReviewFileKind; className?: string }) {
  const chip = KIND_CHIP[kind];
  return (
    <span data-diff-status={kind} className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded border font-mono text-3xs leading-none", TONE[kind], className)}>
      <span aria-hidden="true">{chip.letter}</span>
      <span className="sr-only">{chip.word}</span>
    </span>
  );
}
