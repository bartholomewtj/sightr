// Sightr code (T29). The row above the composer box, beside the attachment chips: "3 review comments · Add to message ·
// View · Discard". The comments are the basket (state/lineComments.ts); the draft is the user's words. Add appends the
// blocks at the end of the draft through the composer (never inserted mid-text, never automatic). It hides while a
// request replaces the box, because the composer renders it only in the box's place.
import { MessageSquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useLayout } from "@/hooks/useLayout";
import { openRightPanelSurface } from "@/rightPanelStore";
import { addToMessage, discardAll, useAddGate } from "@/state/commentActions";
import { setCommentsListOpen } from "@/state/commentsUi";
import { commentView, useLineComments } from "@/state/lineComments";
import { Button } from "../ui/button";

export function ReviewCommentsBar({ threadId, text }: { threadId: string; text: string }) {
  const comments = useLineComments(threadId);
  const gate = useAddGate(threadId);
  const phone = useLayout() === "phone";
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3_000);
    return () => clearTimeout(t);
  }, [armed]);
  if (comments.length === 0) return null;
  const waiting = comments.filter((c) => commentView(c, text) !== "in message");
  const addable = waiting.filter((c) => c.state !== "outdated");
  const outdated = waiting.length - addable.length;
  return (
    <div data-review-comments-bar="" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-card px-2 py-1 text-xs">
      <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {comments.length} review comment{comments.length === 1 ? "" : "s"}
        {waiting.length < comments.length ? ` (${comments.length - waiting.length} in message)` : ""}
        {outdated > 0 ? ` (${outdated} outdated)` : ""}
      </span>
      <Button size="xs" variant="outline" disabled={!gate.ok || addable.length === 0} title={gate.ok ? undefined : gate.reason} onClick={() => addToMessage(threadId, comments, text, { phone })}>
        Add to message
      </Button>
      <Button
        size="xs"
        variant="ghost-muted"
        onClick={() => {
          setCommentsListOpen(threadId, true);
          openRightPanelSurface("diff");
        }}
      >
        View
      </Button>
      <Button
        size="xs"
        variant={armed ? "destructive" : "ghost-muted"}
        onClick={() => {
          if (armed) {
            discardAll(threadId);
            setArmed(false);
          } else setArmed(true);
        }}
      >
        {armed ? "Tap again to discard" : "Discard"}
      </Button>
      {!gate.ok ? <span className="basis-full text-muted-foreground">{gate.reason} Add is off.</span> : null}
    </div>
  );
}
