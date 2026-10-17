// Adapted from T3 Code apps/web/src/components/settings/FoldedSettingsSection.tsx @ db5919d87daf (MIT, see THIRD_PARTY.md).
// Kept: the "inside" header (a full-width trigger row with a chevron, a title, a one-line summary and
// an optional control) over a collapsible panel of divided rows, and the `id` / focus target.
// Changed: no settings-search target (Sightr has no settings search), so the fold is opened by the
// caller through `open` / `onOpenChange` (the section chips open "Advanced" before they scroll to it);
// the "outside" header is dropped. The trigger is 44 px high on a phone.
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { SettingsGroup } from "./SettingsGroup";

export function FoldedSettingsSection({
  id,
  title,
  summary,
  control,
  open: openProp,
  onOpenChange,
  children,
}: {
  readonly id: string;
  readonly title: ReactNode;
  readonly summary?: string | null;
  readonly control?: ReactNode;
  /** Controlled open state; omit to let the section keep its own (closed at first). */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const setOpen = (next: boolean) => {
    setOwn(next);
    onOpenChange?.(next);
  };

  return (
    <section id={id} tabIndex={-1} className="scroll-mt-4 outline-none">
      <Collapsible open={open} onOpenChange={setOpen} render={<SettingsGroup divided={false} />}>
        <div className="flex items-center gap-4 px-3 sm:px-4">
          <CollapsibleTrigger className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            <span className="shrink-0 text-sm font-medium">{title}</span>
            {summary ? <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span> : null}
          </CollapsibleTrigger>
          {control ? <div className="flex shrink-0 items-center">{control}</div> : null}
        </div>
        <CollapsiblePanel>
          <div className="flex flex-col gap-8 border-t border-border/50 px-0 pt-6 pb-4">{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
