// Same job and name as T3 Code's apps/web/src/components/settings/OpenSourceLicenses.tsx @ db5919d87daf (MIT,
// see THIRD_PARTY.md), Sightr's own body. T3 loads a searchable manifest of every dependency's notice,
// built at release time. Sightr has no such manifest: web2/THIRD_PARTY.md (the T3 Code MIT notice that
// the adopted files require) is bundled as text and shown in a fold, with a link to the repository.
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";
import notices from "../../../THIRD_PARTY.md?raw";
import { SettingsRow } from "./settingsLayout";

export const T3_REPOSITORY_URL = "https://github.com/pingdotgg/t3code";

export function OpenSourceLicenses() {
  const [open, setOpen] = useState(false);
  return (
    <SettingsRow
      title="Open-source licences"
      description="Parts of this app are adapted from T3 Code (MIT), and diffs are coloured with highlight.js (BSD-3-Clause). The notices that come with them are below."
      control={
        <Button size="sm" variant="outline" render={<a href={T3_REPOSITORY_URL} target="_blank" rel="noreferrer noopener" />}>
          <ExternalLinkIcon />
          T3 Code
        </Button>
      }
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="mt-3 flex min-h-11 items-center gap-2 rounded-md text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8">
          <ChevronRightIcon aria-hidden className={cn("size-4 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")} />
          {open ? "Hide the notice" : "Show the notice"}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <pre data-testid="licence-notice" className="mt-2 max-h-80 overflow-auto rounded-lg border border-border/50 p-3 font-mono text-xs/5 whitespace-pre-wrap break-words text-foreground/80">
            {notices.trim()}
          </pre>
        </CollapsiblePanel>
      </Collapsible>
    </SettingsRow>
  );
}
