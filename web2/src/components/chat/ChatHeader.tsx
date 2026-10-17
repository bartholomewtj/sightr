// Pattern of T3 Code apps/web/src/components/chat/ChatHeader.tsx @ db5919d87 (MIT, see THIRD_PARTY.md).
// resolveRenameCommit is verbatim. The rest is Sightr's: the title is the thread menu's trigger (T3's
// title tap) and opens the sidebar's ThreadRowMenu (rename, pin, mark unread, snooze, settle,
// archive) with the same commands; no breadcrumb, parent link or double-click (touch has none):
// Rename is a menu item that turns the title into a field. Read-only devices and archived threads
// get the plain title.
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Thread } from "@shared/v2/contracts";
import { CustomSnoozeDialog } from "@/components/CustomSnoozeDialog";
import type { ShelfCommand } from "@/components/Sidebar.logic";
import { ThreadRowMenu } from "@/components/sidebar/ThreadRowMenu";
import { performThreadCommand } from "@/state/sidebar";
import { cn } from "~/lib/utils";

export function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

export function ChatHeader({
  title,
  thread,
  canOperate,
}: {
  title: string;
  /** The thread the menu acts on; null while it loads. */
  thread: Thread | null;
  /** False on a read-only device or a missing thread: the title is plain text. */
  canOperate: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [snoozePick, setSnoozePick] = useState<string | null>(null);
  const threadId = thread?.id ?? null;
  // Another thread (or the thread going away) ends a rename or an open menu.
  useEffect(() => {
    setRenaming(null);
    setMenuOpen(false);
  }, [threadId]);

  const operable = canOperate && thread !== null && thread.shelf !== "archived";
  if (!operable) {
    return <h1 className="min-w-0 flex-1 truncate font-semibold">{title}</h1>;
  }

  const run = (command: ShelfCommand) => void performThreadCommand(command);

  if (renaming !== null) {
    return (
      <h1 className="min-w-0 flex-1">
        <RenameTitleField
          title={thread.title}
          onDone={() => {
            setRenaming(null);
            requestAnimationFrame(() => triggerRef.current?.focus());
          }}
          onCommit={(next) => run({ type: "thread.rename", threadId: thread.id, title: next })}
        />
      </h1>
    );
  }

  return (
    <>
      <h1 className="flex min-w-0 flex-1">
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Thread actions"
          data-thread-title-menu=""
          className="-mx-1.5 flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-1 text-start font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
          onClick={() => setMenuOpen(true)}
        >
          <span className="min-w-0 truncate">{title}</span>
          <ChevronDownIcon aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground transition-transform", menuOpen && "rotate-180")} />
        </button>
      </h1>
      <ThreadRowMenu
        thread={menuOpen ? thread : null}
        anchor={menuOpen ? triggerRef.current : null}
        onClose={() => setMenuOpen(false)}
        run={run}
        // The menu's close moves focus back to the trigger; the field takes it after that.
        onRename={(id) => setTimeout(() => setRenaming(id), 0)}
        onPickSnooze={(id) => setSnoozePick(id)}
      />
      <CustomSnoozeDialog
        open={snoozePick !== null}
        onOpenChange={(open) => {
          if (!open) setSnoozePick(null);
        }}
        onSnooze={(until) => {
          if (snoozePick) run({ type: "thread.snooze", threadId: snoozePick, until });
        }}
      />
    </>
  );
}

/** The title as a field: Enter or leaving it renames, Escape cancels, an empty title is refused. */
function RenameTitleField({ title, onDone, onCommit }: { title: string; onDone(): void; onCommit(title: string): void }) {
  const [value, setValue] = useState(title);
  const [rejected, setRejected] = useState(false);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    if (commit) {
      const result = resolveRenameCommit({ title: value, originalTitle: title });
      if (result.action === "reject-empty") {
        setRejected(true);
        return;
      }
      if (result.action === "commit") onCommit(result.title);
    }
    done.current = true;
    onDone();
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the field opens from the Rename menu item
      autoFocus
      aria-label="Thread title"
      aria-invalid={rejected || undefined}
      value={value}
      enterKeyHint="done"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-base font-semibold text-foreground outline-none focus:border-ring sm:text-sm pointer-coarse:h-11",
        rejected && "border-destructive",
      )}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        setValue(e.target.value);
        setRejected(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => {
        // An empty title on blur cancels rather than trapping focus.
        if (resolveRenameCommit({ title: value, originalTitle: title }).action === "reject-empty") finish(false);
        else finish(true);
      }}
    />
  );
}
