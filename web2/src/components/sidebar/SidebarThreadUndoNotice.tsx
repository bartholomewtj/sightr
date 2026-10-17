// Adapted from T3 Code apps/web/src/components/sidebar/SidebarThreadUndoNotice.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: "Settled · Undo" (one thread at a time), a fixed shortcut label instead of T3's keybinding atom,
// and a 44 px Undo target on touch.
import { undoLatestThreadAction, useThreadUndoNotice } from "@/hooks/showThreadUndoNotice";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  if (!notice) return null;
  return (
    <div
      role="status"
      className="pointer-events-auto flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-foreground shadow-lg"
    >
      <span>{notice.action}</span>
      <span aria-hidden className="text-muted-foreground">
        ·
      </span>
      <button
        type="button"
        className="-my-2 font-medium text-house-accent underline-offset-4 hover:underline pointer-coarse:min-h-11 pointer-coarse:px-3"
        onClick={undoLatestThreadAction}
        title={isMac() ? "⌘Z" : "Ctrl+Z"}
      >
        Undo
      </button>
    </div>
  );
}
