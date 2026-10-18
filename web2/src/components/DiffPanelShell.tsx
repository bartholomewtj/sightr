// Pattern from T3 Code apps/web/src/components/DiffPanelShell.tsx @ 3a4d118a518a (MIT, see THIRD_PARTY.md):
// a header slot over a body, and the loading frame. T3's shell is sized for its own panel modes (inline,
// sheet, sidebar, embedded) and its Electron drag region; Sightr's panel always sits inside the right panel
// or the phone sheet, which already supply the frame, so this is the slot and the frames only.
import type { ReactNode, Ref } from "react";

import { cn } from "~/lib/utils";

export function DiffPanelShell(props: { header: ReactNode; children: ReactNode; className?: string; panelRef?: Ref<HTMLDivElement> }) {
  return (
    <div ref={props.panelRef} className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-background", props.className)} data-diff-panel="">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1" data-surface-subheader="">
        {props.header}
      </div>
      {props.children}
    </div>
  );
}

function Bar({ className }: { className: string }) {
  return <div className={cn("h-3 rounded-full bg-muted motion-safe:animate-pulse", className)} />;
}

/** While the file list loads: a few file headers' worth of grey. */
export function DiffPanelLoadingState({ label }: { label: string }) {
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-hidden p-3" role="status" aria-live="polite" aria-label={label} data-diff-loading="">
      {["w-2/5", "w-3/5", "w-1/2"].map((w) => (
        <div key={w} className="space-y-2">
          <Bar className={w} />
          <Bar className="w-4/5" />
          <Bar className="w-2/3" />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** A sentence in the body's place: unavailable, empty, error. */
export function DiffPanelMessage(props: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground" data-diff-message="">
      <p>{props.children}</p>
      {props.action}
    </div>
  );
}
