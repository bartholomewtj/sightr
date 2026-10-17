/**
 * The row menu (T10): Rename, Pin/Unpin, Mark unread/read, Snooze (presets, Pick time, Wake now),
 * Settle/Unsettle, Archive. One menu for the whole sidebar, anchored to the row that opened it (right
 * click, `Space`, or a long press on touch). It is also the keyboard alternative to dragging. Copy thread id
 * and Copy folder path are the palette's actions (`threadCopy.ts`).
 */
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator } from "~/components/ui/menu";

import type { Thread } from "@shared/v2/contracts";
import type { ShelfCommand } from "@/components/Sidebar.logic";
import { resolveSnoozePresets } from "@/components/Sidebar.snooze";
import { copyThreadFolderPath, copyThreadId } from "@/components/sidebar/threadCopy";

const TOUCH_ITEM = "pointer-coarse:min-h-11";

export function ThreadRowMenu({
  thread,
  anchor,
  onClose,
  run,
  onRename,
  onPickSnooze,
}: {
  thread: Thread | null;
  anchor: HTMLElement | null;
  onClose(): void;
  run(command: ShelfCommand): void;
  onRename(threadId: string): void;
  onPickSnooze(threadId: string): void;
}) {
  const open = thread !== null && anchor !== null;
  const threadId = thread?.id ?? "";
  const presets = open ? resolveSnoozePresets(new Date()) : [];
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {open ? (
        <MenuPopup anchor={anchor} align="start" side="bottom" aria-label={`Actions for ${thread.title}`}>
          <MenuItem className={TOUCH_ITEM} onClick={() => onRename(threadId)}>Rename</MenuItem>
          {thread.shelf === "pinned" ? (
            <MenuItem className={TOUCH_ITEM} onClick={() => run({ type: "thread.unpin", threadId })}>Unpin</MenuItem>
          ) : (
            <MenuItem className={TOUCH_ITEM} onClick={() => run({ type: "thread.pin", threadId })}>Pin</MenuItem>
          )}
          {thread.unreadDone ? (
            <MenuItem className={TOUCH_ITEM} onClick={() => run({ type: "thread.markRead", threadId })}>Mark read</MenuItem>
          ) : (
            <MenuItem className={TOUCH_ITEM} onClick={() => run({ type: "thread.markUnread", threadId })}>Mark unread</MenuItem>
          )}
          <MenuItem className={TOUCH_ITEM} onClick={() => void copyThreadId(threadId)}>Copy thread id</MenuItem>
          {thread.paneId !== "" ? (
            <MenuItem className={TOUCH_ITEM} onClick={() => void copyThreadFolderPath(thread.paneId)}>Copy folder path</MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Snooze</MenuGroupLabel>
            {presets.map((p) => (
              <MenuItem key={p.id} className={TOUCH_ITEM} onClick={() => run({ type: "thread.snooze", threadId, until: p.snoozedUntil })}>
                <span className="flex-1">{p.label}</span>
                <span className="font-mono text-2xs text-muted-foreground">{p.whenLabel}</span>
              </MenuItem>
            ))}
            <MenuItem className={TOUCH_ITEM} onClick={() => onPickSnooze(threadId)}>Pick time…</MenuItem>
            {thread.shelf === "snoozed" ? (
              <MenuItem className={TOUCH_ITEM} onClick={() => run({ type: "thread.unsnooze", threadId })}>Wake now</MenuItem>
            ) : null}
          </MenuGroup>
          <MenuSeparator />
          {thread.shelf === "settled" ? (
            <MenuItem className={TOUCH_ITEM} onClick={() => run({ type: "thread.unsettle", threadId })}>Unsettle</MenuItem>
          ) : (
            <MenuItem className={TOUCH_ITEM} onClick={() => run({ type: "thread.settle", threadId })}>Settle</MenuItem>
          )}
          <MenuItem variant="destructive" className={TOUCH_ITEM} onClick={() => run({ type: "thread.archive", threadId })}>
            Archive
          </MenuItem>
        </MenuPopup>
      ) : null}
    </Menu>
  );
}
