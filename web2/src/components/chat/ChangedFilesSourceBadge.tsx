// Sightr code (T31). The badge on the changed-files card's header and the Diff panel's run header: "Exact" for a list
// compared from the run's git snapshots, "From agent edits" for the journal's. A button (44 px under a coarse pointer)
// that opens `ChangedFilesSourceSheet`. "Exact" is only ever drawn for source `checkpoint`, which `resolveRunChanges`
// gives only for a `ready` checkpoint.
import { CheckIcon, InfoIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { ChangedFilesSourceSheet, type SourceSheetInfo } from "./ChangedFilesSourceSheet";

export function sourceBadgeText(source: SourceSheetInfo["source"]): string {
  return source === "checkpoint" ? "Exact" : "From agent edits";
}

export function ChangedFilesSourceBadge({ info, className }: { info: SourceSheetInfo; className?: string }) {
  const text = sourceBadgeText(info.source);
  return (
    <ChangedFilesSourceSheet
      info={info}
      trigger={
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          aria-haspopup="dialog"
          aria-label={`${text}. What does this mean?`}
          data-source-badge={info.source}
          className={cn("gap-1 rounded-full border-border/60 text-3xs leading-4 pointer-coarse:min-h-11", info.source === "checkpoint" && "text-success", className)}
        >
          {info.source === "checkpoint" ? <CheckIcon aria-hidden="true" className="size-3" /> : <InfoIcon aria-hidden="true" className="size-3" />}
          {text}
        </Button>
      }
    />
  );
}
