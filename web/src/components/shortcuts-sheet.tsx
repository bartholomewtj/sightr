import { BottomSheet } from "@/components/ui/sheet";
import { closeShortcuts, DESKTOP_HOTKEYS, useShortcutsOpen } from "@/hooks/use-desktop-hotkeys";

export function ShortcutsSheet() {
  const open = useShortcutsOpen();
  return (
    <BottomSheet open={open} onClose={closeShortcuts} title="Keyboard shortcuts">
      <dl className="divide-y divide-border/60">
        {DESKTOP_HOTKEYS.map((binding) => (
          <div key={binding.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
            <dt className="text-sm">{binding.label}</dt>
            <dd className="flex gap-1">{binding.keys.map((key) => <kbd key={key} className="rounded border border-border bg-muted px-2 py-1 font-mono text-xs">{key}</kbd>)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">Enter sends · Shift+Enter starts a new line.</p>
    </BottomSheet>
  );
}
