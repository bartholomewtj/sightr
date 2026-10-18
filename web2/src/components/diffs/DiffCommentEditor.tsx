// Pattern from T3 Code apps/web/src/components/diffs/DiffCommentAnnotation.tsx @ 3a4d118a518a (MIT, see THIRD_PARTY.md).
// T3's draft annotation is a Textarea with Cancel and Comment buttons and a Mod+Enter shortcut, inside Pierre's
// annotation slot. This is the same job as an annotation row under the last line of a range (T29): a plain
// <textarea> (phone dictation works) with Save and Cancel at 44 px on a touch screen, Mod+Enter to save on a
// desktop (`commentSubmitShortcut.ts`, T3's rule verbatim), Escape to cancel, and Enter adds a line everywhere.
import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { isCommentSubmitShortcut } from "./commentSubmitShortcut";
import { MAX_NOTE_CHARS } from "@/lib/reviewCommentContext";

export interface DiffCommentEditorProps {
  /** `12` or `12-15`, as the block header will say. */
  rangeLabel: string;
  side: "old" | "new";
  /** The note so far (the editor keeps its own copy while typing, so a keystroke does not redraw the diff). */
  initialNote: string;
  /** More than one line is selected: Clear range is offered. */
  canClear: boolean;
  /** A word under the box: the 12-line limit, a refusal. */
  notice: string | null;
  editing: boolean;
  onSave: (note: string) => void;
  onCancel: () => void;
  onClear: () => void;
  /** Every keystroke, so the note outlives a remount (the range moved, so the row did). */
  onNote?: (note: string) => void;
}

const coarse = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

export function DiffCommentEditor({ rangeLabel, side, initialNote, canClear, notice, editing, onSave, onCancel, onClear, onNote }: DiffCommentEditorProps) {
  const [note, setNote] = useState(initialNote);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // A desktop gets the cursor at once. A phone does not: the keyboard would cover the diff, and the next tap on a line number extends the range.
  useLayoutEffect(() => {
    if (!coarse()) boxRef.current?.focus({ preventScroll: true });
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  const trimmed = note.trim();
  const tooLong = trimmed.length > MAX_NOTE_CHARS;
  return (
    <div ref={rowRef} data-diff-comment-editor="" className="border-s-2 border-[var(--accent)] bg-card px-2 py-2 font-sans text-sm text-foreground" onPointerDown={(e) => e.stopPropagation()}>
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">
          {editing ? "Editing the comment on" : "Comment on"} {side === "old" ? "old" : "new"} line{rangeLabel.includes("-") ? "s" : ""} {rangeLabel}
        </span>
        {canClear ? (
          <Button size="xs" variant="ghost-muted" onClick={onClear}>
            Clear range
          </Button>
        ) : null}
      </div>
      <textarea
        ref={boxRef}
        aria-label={`Comment on ${side} lines ${rangeLabel}`}
        value={note}
        rows={3}
        autoCapitalize="sentences"
        placeholder="What should change here?"
        className="block w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-base outline-none focus:border-ring sm:text-sm"
        onChange={(e) => {
          setNote(e.target.value);
          onNote?.(e.target.value);
        }}
        onFocus={() => rowRef.current?.scrollIntoView?.({ block: "nearest" })}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
            return;
          }
          if (e.nativeEvent.isComposing) return;
          if (isCommentSubmitShortcut(e, trimmed, tooLong)) {
            e.preventDefault();
            onSave(trimmed);
          }
        }}
      />
      {notice ? (
        <p role="status" className="mt-1 text-xs text-[var(--warn)]">
          {notice}
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1">
        <span className={`mr-auto text-xs ${tooLong ? "text-[var(--warn)]" : "text-muted-foreground"}`}>
          {trimmed.length}/{MAX_NOTE_CHARS}
        </span>
        <Button size="xs" variant="ghost-muted" className="pointer-coarse:min-h-11" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" className="pointer-coarse:min-h-11" disabled={trimmed === "" || tooLong} onClick={() => onSave(trimmed)}>
          Save
        </Button>
      </div>
    </div>
  );
}
