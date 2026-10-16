// Adapted from T3 Code apps/web/src/components/chat/QueuedRunsControl.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: rows are the bridge's persisted queue (`thread.queue`, T06), not queued runs in a projection;
// reorder posts the whole order (`queued.reorder`), Steer is "send as steer, then cancel the row" (no
// promote command), Cancel offers Undo. Rows held after a restart or failed sends say why, with one
// Resume (`queue.resume`). Each row also has a menu with Move up / Move down, the touch alternative to
// T3's grip drag. No optimistic rows and no image thumbnails (an attachment count instead).
import { useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CornerUpRightIcon,
  EllipsisIcon,
  GripVerticalIcon,
  ListOrderedIcon,
  PaperclipIcon,
  PencilIcon,
  PlayIcon,
} from "lucide-react";

import type { QueuedMessage } from "@shared/v2/contracts";
import { cn } from "~/lib/utils";
import { cancelQueued, moveQueued, resumeQueue, steerQueued } from "@/state/composer";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { firstLine, heldReasonText, queueHeldSummary } from "./ChatComposer.logic";
import { ComposerBanner } from "./ComposerBanner";

const QUEUED_RUN_DRAG_TYPE = "application/x-sightr-queued-message";

export interface QueuedRunsControlHandle {
  steerNext: () => boolean;
  editLatest: () => boolean;
}

export function QueuedRunsControl({
  ref,
  threadId,
  queue,
  canSteer,
  editingId,
  onEditQueued,
  onCancelEdit,
}: {
  readonly ref?: Ref<QueuedRunsControlHandle>;
  readonly threadId: string;
  readonly queue: readonly QueuedMessage[];
  /** The thread is working and can steer (`canInterrupt && canQueueDrain`). */
  readonly canSteer: boolean;
  readonly editingId: string | null;
  readonly onEditQueued: (row: QueuedMessage) => void;
  readonly onCancelEdit: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const queueListId = useId();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<{ id: string; insertIndex: number | null } | null>(null);
  // As T3: a drag must start from the grip, not from a text drag on the row.
  const dragArmedIdRef = useRef<string | null>(null);
  const summary = queueHeldSummary(queue);

  const run = async (id: string, work: () => Promise<void>) => {
    setBusyId(id);
    try {
      await work();
    } finally {
      setBusyId(null);
    }
  };
  const move = (id: string, index: number) => run(id, () => moveQueued(threadId, queue, id, index));
  const steer = (row: QueuedMessage) => run(row.id, () => steerQueued(threadId, row));
  const remove = (row: QueuedMessage) => run(row.id, () => cancelQueued(threadId, row, queue));

  useImperativeHandle(ref, () => ({
    steerNext() {
      const next = queue.find((q) => q.state === "queued");
      if (!next || !canSteer || busyId !== null) return false;
      void steer(next);
      return true;
    },
    editLatest() {
      const latest = [...queue].reverse().find((q) => q.state !== "sending");
      if (!latest || editingId !== null || busyId !== null) return false;
      setExpanded(true);
      onEditQueued(latest);
      return true;
    },
  }));

  if (queue.length === 0) return null;

  const completeDrag = (id: string, insertIndex: number | null) => {
    setDragState(null);
    dragArmedIdRef.current = null;
    if (insertIndex === null || busyId !== null) return;
    const from = queue.findIndex((q) => q.id === id);
    if (from === -1 || insertIndex === from || insertIndex === from + 1) return;
    void move(id, insertIndex > from ? insertIndex - 1 : insertIndex);
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root role="region" aria-label={`${queue.length} queued message${queue.length === 1 ? "" : "s"}`} aria-live="polite">
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-label={expanded ? "Collapse queued messages" : "Expand queued messages"}
          aria-expanded={expanded}
          aria-controls={queueListId}
          onClick={() => setExpanded((value) => !value)}
        >
          <ComposerBanner.Icon>
            <ListOrderedIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground">
            Queued ({queue.length})
            {summary.held ? (
              <>
                <ComposerBanner.Separator />
                <span className="text-warning">{summary.restart ? "Paused after restart" : "Paused"}</span>
              </>
            ) : null}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {summary.held && summary.resumable ? (
          <div className="flex items-center justify-end px-1 pb-1">
            <Button size="xs" variant="outline" onClick={() => void resumeQueue(threadId)}>
              <PlayIcon className="size-3" aria-hidden="true" />
              Resume
            </Button>
          </div>
        ) : null}
        <ComposerBanner.Scroll className={cn("max-h-40", !expanded && "hidden")}>
          <ComposerBanner.Children render={<ol />} id={queueListId}>
            {queue.map((item, index) => {
              const isEditing = item.id === editingId;
              const sending = item.state === "sending";
              const held = item.state === "held";
              const rowBusy = busyId !== null || sending;
              const preview = firstLine(item.text);
              return (
                <ComposerBanner.Row
                  render={<li />}
                  key={item.id}
                  data-queued-id={item.id}
                  aria-current={isEditing ? "true" : undefined}
                  className={cn(
                    "relative rounded-sm",
                    isEditing && "bg-accent text-accent-foreground",
                    dragState !== null && dragState.id === item.id && "opacity-50",
                  )}
                  draggable={!rowBusy && queue.length > 1}
                  onDragStart={(event) => {
                    if (dragArmedIdRef.current !== item.id) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.setData(QUEUED_RUN_DRAG_TYPE, item.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDragState({ id: item.id, insertIndex: null });
                  }}
                  onDragEnd={() => {
                    dragArmedIdRef.current = null;
                    setDragState(null);
                  }}
                  onDragOver={(event) => {
                    if (dragState === null) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const rect = event.currentTarget.getBoundingClientRect();
                    const insertIndex = event.clientY < rect.top + rect.height / 2 ? index : index + 1;
                    if (dragState.insertIndex !== insertIndex) setDragState({ id: dragState.id, insertIndex });
                  }}
                  onDrop={(event) => {
                    if (dragState === null) return;
                    event.preventDefault();
                    completeDrag(dragState.id, dragState.insertIndex);
                  }}
                >
                  {dragState?.insertIndex === index ? (
                    <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded bg-primary/70" />
                  ) : null}
                  {index === queue.length - 1 && dragState?.insertIndex === queue.length ? (
                    <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded bg-primary/70" />
                  ) : null}
                  <ComposerBanner.Icon aria-hidden={false}>
                    {queue.length > 1 ? (
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label="Reorder queued message (drag, or press the arrow keys)"
                        className="cursor-grab active:cursor-grabbing disabled:cursor-default"
                        disabled={rowBusy}
                        onPointerDown={() => {
                          dragArmedIdRef.current = item.id;
                        }}
                        onKeyDown={(event) => {
                          if (rowBusy) return;
                          if (event.key === "ArrowUp" && index > 0) {
                            event.preventDefault();
                            void move(item.id, index - 1);
                          }
                          if (event.key === "ArrowDown" && index < queue.length - 1) {
                            event.preventDefault();
                            void move(item.id, index + 1);
                          }
                        }}
                      >
                        <GripVerticalIcon />
                      </Button>
                    ) : (
                      <span className="tabular-nums text-muted-foreground">{index + 1}</span>
                    )}
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content className="text-foreground/80">
                    <span className="sr-only">{`${index + 1}. `}</span>
                    {isEditing ? <span className="sr-only">Editing queued message: </span> : null}
                    <span className="min-w-0 flex-1 truncate" title={item.text}>
                      {preview}
                    </span>
                    {item.attachments.length > 0 ? (
                      <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground" aria-label={`${item.attachments.length} attachments`}>
                        <PaperclipIcon className="size-3" aria-hidden="true" />
                        {item.attachments.length}
                      </span>
                    ) : null}
                    {sending ? <span className="shrink-0 text-muted-foreground">Sending…</span> : null}
                    {held && !summary.restart ? <span className="shrink-0 text-warning">{heldReasonText(item.heldReason)}</span> : null}
                  </ComposerBanner.Content>
                  <ComposerBanner.Actions>
                    {isEditing ? (
                      <Button size="xs" variant="ghost" aria-label="Cancel editing queued message" onClick={onCancelEdit}>
                        Cancel
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label="Edit queued message"
                          disabled={rowBusy || editingId !== null}
                          onClick={() => onEditQueued(item)}
                        >
                          <PencilIcon />
                        </Button>
                        {canSteer ? (
                          <Button size="xs" variant="ghost-muted" disabled={rowBusy} onClick={() => void steer(item)}>
                            <CornerUpRightIcon />
                            Steer now
                          </Button>
                        ) : null}
                        <Menu>
                          <MenuTrigger
                            disabled={rowBusy}
                            render={<Button size="icon-xs" variant="ghost-muted" aria-label="More for this queued message" />}
                          >
                            <EllipsisIcon />
                          </MenuTrigger>
                          <MenuPopup side="top" align="end">
                            <MenuItem disabled={index === 0} onClick={() => void move(item.id, index - 1)}>
                              <ArrowUpIcon className="size-3.5" aria-hidden="true" />
                              Move up
                            </MenuItem>
                            <MenuItem disabled={index === queue.length - 1} onClick={() => void move(item.id, index + 1)}>
                              <ArrowDownIcon className="size-3.5" aria-hidden="true" />
                              Move down
                            </MenuItem>
                          </MenuPopup>
                        </Menu>
                        <ComposerBanner.Dismiss aria-label="Remove queued message" disabled={rowBusy} onClick={() => void remove(item)} />
                      </>
                    )}
                  </ComposerBanner.Actions>
                </ComposerBanner.Row>
              );
            })}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
