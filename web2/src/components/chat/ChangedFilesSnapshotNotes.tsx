// Sightr code (T31). What an exact (checkpoint) list says under itself, for the card and the Diff panel's run scope:
// the edits the run undid ("N edited and reverted", opening their names, dimmed, with no counts), files the snapshot
// could not show, a list cut at its cap, and the three flags T30 sets on a snapshot that may not be clean.
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import type { RunChanges } from "@/lib/runChanges";

export const SHARED_NOTE = "Another thread was working in this folder, so its edits may be included.";
export const APPROXIMATE_NOTE = "Start snapshot was taken late; earlier edits may be missing.";
export const UNSETTLED_NOTE = "Files were still changing when the snapshot was taken.";

export function ChangedFilesSnapshotNotes({ changes, className }: { changes: RunChanges; className?: string }) {
  const [open, setOpen] = useState(false);
  if (changes.source !== "checkpoint") return null;
  const notes: Array<{ key: string; text: string }> = [];
  if (changes.truncated) notes.push({ key: "truncated", text: `Showing the first ${changes.files.length} files. The counts include every file.` });
  if (changes.notShown > 0) notes.push({ key: "not-shown", text: `${changes.notShown} file${changes.notShown === 1 ? "" : "s"} not shown` });
  if (changes.shared) notes.push({ key: "shared", text: SHARED_NOTE });
  if (changes.approximate) notes.push({ key: "approximate", text: APPROXIMATE_NOTE });
  if (changes.unsettled) notes.push({ key: "unsettled", text: UNSETTLED_NOTE });
  // An empty net diff says it in one line of its own (the card and the panel); the names would repeat it.
  const reverted = changes.state === "empty" ? 0 : changes.revertedCount;
  if (notes.length === 0 && reverted === 0) return null;
  return (
    <div className={cn("flex flex-col gap-1 px-3 pb-2 text-2xs text-muted-foreground", className)} data-snapshot-notes="">
      {reverted > 0 ? (
        <div data-reverted="">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-1 rounded-md py-1 text-left hover:text-foreground pointer-coarse:min-h-11"
          >
            <ChevronRightIcon aria-hidden="true" className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
            {reverted} edited and reverted
          </button>
          {open ? (
            <ul className="ml-4 flex flex-col gap-0.5 font-mono text-muted-foreground/60" data-reverted-names="">
              {changes.reverted.map((path, i) => (
                <li key={`${i}:${path}`} className="wrap-anywhere">
                  {path}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {notes.map((note) => (
        <p key={note.key} data-snapshot-note={note.key}>
          {note.text}
        </p>
      ))}
    </div>
  );
}
