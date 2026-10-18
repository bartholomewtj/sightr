// Sightr code (T29). The pending line comments of a thread, inside the Diff panel (a phone may not open a second sheet, so
// the list takes the panel's body, and Back returns to the files). A row is `path:12-14`, the side, a state, the
// note and the quoted lines, with Add, Edit and Delete; the header has Add all and Discard all (a second tap).
// Add puts the comment's block at the end of the composer's text (state/commentActions.ts); nothing here edits the draft.
import { ArrowLeftIcon, MessageSquarePlusIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { useLayout } from "@/hooks/useLayout";
import { useBridgeInfo } from "@/stream/stores";
import { addToMessage, deleteWithUndo, discardAll, useAddGate } from "@/state/commentActions";
import { useDraftText } from "@/state/composer";
import { commentView, useLineComments, type CommentView, type LineComment } from "@/state/lineComments";

import { Button } from "../ui/button";
import { rangeLabelOf } from "./DiffCommentAnnotation";

const STATE_LABEL: Record<CommentView, string> = { pending: "Pending", "in message": "In message", moved: "Moved", outdated: "Outdated" };
const ARM_MS = 3_000;

export function LineCommentsList({
  threadId,
  inScope,
  onBack,
  onJump,
  onEdit,
}: {
  threadId: string;
  /** Paths in the scope now showing; a comment on another path cannot be jumped to. */
  inScope: ReadonlySet<string>;
  onBack: () => void;
  onJump: (c: LineComment) => void;
  onEdit: (c: LineComment) => void;
}) {
  const comments = useLineComments(threadId);
  const draft = useDraftText(threadId);
  const gate = useAddGate(threadId);
  const readOnly = useBridgeInfo((s) => s.readOnly);
  const phone = useLayout() === "phone";
  const [armed, setArmed] = useState<string | null>(null); // "discard", or the id of an outdated comment waiting for its confirm tap
  useEffect(() => {
    if (armed === null) return;
    const t = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  const addable = comments.filter((c) => commentView(c, draft) !== "in message" && c.state !== "outdated");
  const skipped = comments.filter((c) => c.state === "outdated" && commentView(c, draft) !== "in message").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-diff-comments-list="">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1">
        <Button size="xs" variant="ghost-muted" onClick={onBack}>
          <ArrowLeftIcon aria-hidden="true" />
          Files
        </Button>
        <span className="min-w-0 flex-1 text-xs font-medium">Review comments · {comments.length}</span>
        <Button size="xs" variant="outline" disabled={!gate.ok || addable.length === 0} onClick={() => addToMessage(threadId, comments, draft, { phone })}>
          <MessageSquarePlusIcon aria-hidden="true" />
          Add all
        </Button>
        <Button
          size="xs"
          variant={armed === "discard" ? "destructive" : "ghost-muted"}
          disabled={comments.length === 0}
          onClick={() => {
            if (armed === "discard") {
              discardAll(threadId);
              setArmed(null);
            } else setArmed("discard");
          }}
        >
          {armed === "discard" ? "Tap again to discard" : "Discard all"}
        </Button>
      </div>
      {!gate.ok ? (
        <p className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground" data-diff-comments-gate="">
          {gate.reason} Comments stay here; Add is off.
        </p>
      ) : skipped > 0 && addable.length > 0 ? (
        <p className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground">Add all leaves out {skipped} outdated comment{skipped === 1 ? "" : "s"}; add one by hand.</p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        {comments.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No pending comments. Tap a line number in a diff to write one.</p>
        ) : (
          <ul className="divide-y">
            {comments.map((c) => {
              const view = commentView(c, draft);
              const confirm = armed === c.id;
              return (
                <li key={c.id} data-comment={c.id} data-comment-state={view} className="px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <button
                      type="button"
                      disabled={!inScope.has(c.path)}
                      onClick={() => onJump(c)}
                      className="min-w-0 break-all text-left font-mono text-xs underline-offset-2 enabled:hover:underline pointer-coarse:min-h-11"
                      title={inScope.has(c.path) ? "Show it in the diff" : "This file is not in the diff being shown"}
                    >
                      {c.path}:{rangeLabelOf(c)}
                    </button>
                    <span className="text-xs text-muted-foreground">{c.side}</span>
                    <span className={cn("rounded-full border px-1.5 text-3xs", view === "outdated" ? "border-[var(--warn)] text-[var(--warn)]" : "text-muted-foreground")}>{STATE_LABEL[view]}</span>
                  </div>
                  <pre className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap break-all rounded border bg-muted/40 px-1.5 py-1 font-mono text-xs leading-4" aria-label="Quoted lines">
                    {c.quote.slice(0, 4).join("\n")}
                    {c.quote.length > 4 ? `\n… ${c.quote.length - 4} more` : ""}
                  </pre>
                  <p className="mt-1 whitespace-pre-wrap wrap-anywhere">{c.note}</p>
                  {confirm ? <p className="mt-1 text-xs text-[var(--warn)]">This code changed since you commented. Tap Add again to add it anyway.</p> : null}
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!gate.ok || view === "in message"}
                      onClick={() => {
                        if (c.state === "outdated" && !confirm) return setArmed(c.id);
                        setArmed(null);
                        addToMessage(threadId, [c], draft, { phone, includeOutdated: true });
                      }}
                    >
                      <MessageSquarePlusIcon aria-hidden="true" />
                      {confirm ? "Add anyway" : "Add"}
                    </Button>
                    <Button size="xs" variant="ghost-muted" disabled={readOnly || !inScope.has(c.path) || c.state === "outdated"} title={readOnly ? "Comments are off: this device is read-only." : c.state === "outdated" ? "Its lines changed; delete it and comment again" : undefined} onClick={() => onEdit(c)}>
                      <PencilIcon aria-hidden="true" />
                      Edit
                    </Button>
                    <Button size="xs" variant="ghost-destructive" onClick={() => deleteWithUndo(threadId, c.id)}>
                      <Trash2Icon aria-hidden="true" />
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
