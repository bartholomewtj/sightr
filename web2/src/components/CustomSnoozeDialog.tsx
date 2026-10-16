/**
 * "Pick time" for a snooze (T10). Same job and name as T3 Code's
 * apps/web/src/components/CustomSnoozeDialog.tsx; Sightr's is one native `datetime-local` field, so the
 * phone's own picker opens.
 */
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { resolveCustomSnooze, toDateTimeLocal } from "@/components/Sidebar.snooze";

const HOUR_MS = 60 * 60 * 1_000;

export function CustomSnoozeDialog({
  open,
  onOpenChange,
  onSnooze,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onSnooze(until: number): void;
}) {
  const [value, setValue] = useState(() => toDateTimeLocal(Date.now() + HOUR_MS));
  const until = resolveCustomSnooze(value, new Date());
  const submit = () => {
    if (until === null) return;
    onSnooze(until);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Snooze until</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3 px-6 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            type="datetime-local"
            aria-label="Wake time"
            className="h-9 rounded-lg border border-input bg-background px-3 font-mono text-sm text-foreground"
            value={value}
            min={toDateTimeLocal(Date.now())}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={until === null}
          />
          {until === null ? <p className="text-xs text-warn">Pick a time in the future.</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={until === null}>
              Snooze
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
