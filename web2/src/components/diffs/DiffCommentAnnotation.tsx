// Pattern from T3 Code apps/web/src/components/diffs/DiffCommentAnnotation.tsx @ 3a4d118a518a (MIT, see THIRD_PARTY.md).
// T3's saved comment is a row with the text and a delete button that shows on hover (always on a small screen). This is
// the note row under a commented range (T29): a tap opens Edit and Delete at 44 px, so a phone needs no hover.
import { MessageCircleIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import type { LineComment } from "@/state/lineComments";
import { Button } from "../ui/button";

export function rangeLabelOf(c: Pick<LineComment, "start" | "end">): string {
  return c.end > c.start ? `${c.start}-${c.end}` : `${c.start}`;
}

export function DiffCommentAnnotation({ comment, onEdit, onDelete }: { comment: LineComment; onEdit: (c: LineComment) => void; onDelete: (c: LineComment) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-diff-comment={comment.id} className="border-s-2 border-[var(--accent)]/60 bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] font-sans text-sm text-foreground" onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-2 px-2 py-1.5 text-left pointer-coarse:min-h-11">
        <MessageCircleIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere">
          <span className="me-1 text-xs text-muted-foreground">{comment.side} {rangeLabelOf(comment)}</span>
          {comment.note}
        </span>
      </button>
      {open ? (
        <div className="flex items-center gap-1 px-2 pb-1.5">
          <Button size="xs" variant="outline" onClick={() => onEdit(comment)}>
            <PencilIcon aria-hidden="true" />
            Edit
          </Button>
          <Button size="xs" variant="ghost-destructive" onClick={() => onDelete(comment)}>
            <Trash2Icon aria-hidden="true" />
            Delete
          </Button>
        </div>
      ) : null}
    </div>
  );
}
