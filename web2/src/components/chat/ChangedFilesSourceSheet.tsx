// Sightr code (T31). What the "Exact" and "From agent edits" badges mean, in words. Below 1024 px a bottom sheet with
// a history entry, so Back closes it (the T13 rule, `useSheetHistory`); above, a popover on the badge. A desktop hover
// is not the only way to the explanation: the badge is a button, 44 px on a touch screen.
import { XIcon } from "lucide-react";
import { cloneElement, useState, type ReactElement } from "react";

import { useLayout } from "@/hooks/useLayout";
import { cn } from "~/lib/utils";
import { fallbackReasonText, type RunChangesState, type FallbackReason } from "@/lib/runChanges";

import { useSheetHistory } from "../sheetHistory";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";

export const EXACT_TEXT =
  "Exact: compared with a snapshot of the folder when the run started and when it ended. Includes changes made by shell commands and drops edits the agent undid.";
export const JOURNAL_TEXT =
  "From agent edits: what the agent's edit tools reported. Shell-made changes are missing, a file the agent later reverted may still be listed, and several edits to one file add up.";

export interface SourceSheetInfo {
  source: "checkpoint" | "journal";
  state?: RunChangesState;
  reason?: FallbackReason | undefined;
  /** An extra line for a state the panel knows and the resolver does not (a diff that failed to load). */
  note?: string | undefined;
}

/** The line giving the cause when the journal is shown; null for an exact list. */
export function sourceReasonLine(info: SourceSheetInfo): string | null {
  if (info.source === "checkpoint") return null;
  if (info.note) return info.note;
  if (info.state === "running") return "This run is still working. The exact list appears when it ends.";
  if (info.state === "finishing") return "The run just ended. The snapshot is being finished.";
  return info.reason ? fallbackReasonText(info.reason) : null;
}

function SourceBody({ info, onClose }: { info: SourceSheetInfo; onClose?: () => void }) {
  const reason = sourceReasonLine(info);
  return (
    <div className="flex flex-col gap-2 p-3 text-sm" data-source-sheet="">
      <div className="flex items-center gap-1">
        <p className="min-w-0 flex-1 text-sm font-medium">Where this list comes from</p>
        {onClose ? (
          <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose}>
            <XIcon />
          </Button>
        ) : null}
      </div>
      <p className={cn(info.source === "checkpoint" ? "text-foreground" : "text-muted-foreground")} data-source-paragraph="exact">
        {EXACT_TEXT}
      </p>
      <p className={cn(info.source === "journal" ? "text-foreground" : "text-muted-foreground")} data-source-paragraph="journal">
        {JOURNAL_TEXT}
      </p>
      {reason ? (
        <p className="rounded-md bg-secondary px-2 py-1.5 text-foreground" data-source-reason="">
          {reason}
        </p>
      ) : null}
    </div>
  );
}

/**
 * `trigger` is the badge's button. Desktop: it opens a popover. Phone: its click opens a bottom sheet that holds one history
 * entry while it is open.
 */
export function ChangedFilesSourceSheet({ trigger, info }: { trigger: ReactElement<{ onClick?: () => void }>; info: SourceSheetInfo }) {
  const layout = useLayout();
  if (layout === "desktop") {
    return (
      <Popover>
        <PopoverTrigger render={trigger} />
        <PopoverPopup align="end" width="md" padding="compact">
          <SourceBody info={info} />
        </PopoverPopup>
      </Popover>
    );
  }
  return <PhoneSheet trigger={trigger} info={info} />;
}

function PhoneSheet({ trigger, info }: { trigger: ReactElement<{ onClick?: () => void }>; info: SourceSheetInfo }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useSheetHistory(open, close);
  return (
    <>
      {cloneElement(trigger, { onClick: () => setOpen(true) })}
      <Sheet open={open} onOpenChange={(next) => !next && close()}>
        <SheetPopup side="bottom" showCloseButton={false} className="max-h-[85dvh] rounded-t-2xl" data-source-sheet-popup="">
          <SheetTitle className="sr-only">Where this list comes from</SheetTitle>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <SourceBody info={info} onClose={close} />
          </div>
        </SheetPopup>
      </Sheet>
    </>
  );
}
