/**
 * The sheet a tap on a changed file opens (T24): that path's edits in one run, in order, each drawn by
 * `FileChangeDetail` (the same detail as an opened edit row). Sightr's own; T3 opens its diff panel
 * instead, which T27 brings for a desktop through `openChangedFile` (`changedFilesTarget.ts`).
 *
 * Shaped like the thread details sheet: `Sheet`/`SheetPopup`, from the bottom (`max-h-[85dvh]`) on a
 * phone and from the right on a desktop, and `useSheetHistory` so Back closes it before it leaves the
 * thread. Mounted beside the list and unmounted when closed. Nothing is fetched: the edits are read from
 * the thread store by item id.
 *
 * The sheet never shows a net diff. The journal holds each edit on its own, so a file edited twice has
 * no single before/after; the sheet says so. "Open file" closes the sheet and opens Files
 * (`openPrintedPath`; a refused path toasts, as everywhere). The path inside each edit's detail is plain
 * text here: with "Open file" on top, a second link would stack the Files sheet over this one.
 */
import type { TurnItem } from "@shared/v2/contracts";
import { FileTextIcon, XIcon } from "lucide-react";
import { useMemo } from "react";

import { useLayout } from "@/hooks/useLayout";
import { useSidebarThread } from "@/state/sidebar";
import { useThread } from "@/stream/stores";
import { orderedItems } from "~/session-logic";
import { cn } from "~/lib/utils";

import { OpenFileThreadContext, openPrintedPath } from "../right-panel/OpenFileLink";
import { useSheetHistory } from "../RightPanelSheet";
import { Button } from "../ui/button";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { deriveRunChangedFilesFromItems, normalizeChangedPath } from "./ChangedFiles.logic";
import { closeChangedFile, useChangedFileTarget, type ChangedFileTarget } from "./changedFilesTarget";
import { FileChangeDetail } from "./ToolItemDetail";

type FileChangeItem = Extract<TurnItem, { type: "file_change" }>;

const STATUS_LABEL: Partial<Record<TurnItem["status"], string>> = {
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
  pending: "running",
  running: "running",
  idle: "running",
  waiting: "running",
};

function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** The changed-file sheet for `threadId`; mounted by the thread's timeline. */
export function ChangedFileSheet({ threadId }: { threadId: string }) {
  const target = useChangedFileTarget(threadId);
  const layout = useLayout();
  const open = target !== null;
  useSheetHistory(open, closeChangedFile);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) closeChangedFile();
      }}
    >
      <SheetPopup
        side={layout === "desktop" ? "right" : "bottom"}
        showCloseButton={false}
        className={layout === "desktop" ? undefined : "max-h-[85dvh] rounded-t-2xl"}
        data-changed-file-sheet=""
      >
        {target ? <ChangedFileContent target={target} /> : null}
      </SheetPopup>
    </Sheet>
  );
}

function ChangedFileContent({ target }: { target: ChangedFileTarget }) {
  const { threadId, runId, path } = target;
  const state = useThread(threadId);
  const shellThread = useSidebarThread(threadId);
  const paneId = (state?.thread ?? shellThread)?.paneId || null;
  const items = state?.items;
  const edits = useMemo(
    () =>
      items
        ? orderedItems(items).filter(
            (item): item is FileChangeItem =>
              item.type === "file_change" && item.runId === runId && normalizeChangedPath(item.fileName) === path,
          )
        : [],
    [items, runId, path],
  );
  const row = useMemo(
    () => (items ? deriveRunChangedFilesFromItems(Object.values(items).filter((item) => item.runId === runId)).get(runId)?.rows.find((r) => r.path === path) : undefined),
    [items, runId, path],
  );

  return (
    <>
      <div className="flex items-start gap-1 border-b px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <SheetTitle className="truncate text-sm font-medium">{fileName(path)}</SheetTitle>
          <p className="font-mono text-2xs text-muted-foreground wrap-anywhere" data-changed-file-path="">
            {path}
          </p>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Close changed file" onClick={closeChangedFile}>
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-changed-file-body="">
        <Button
          size="sm"
          variant="outline"
          className="pointer-coarse:min-h-11"
          onClick={() => {
            // Close first: the Files sheet pushes its own history entry once the path resolves.
            closeChangedFile();
            void openPrintedPath(threadId, paneId, path);
          }}
        >
          <FileTextIcon />
          Open file
        </Button>
        {edits.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-changed-file-empty="">
            These edits aren't loaded any more.
          </p>
        ) : (
          <>
            {row && row.edits > 1 ? (
              <p className="text-xs text-muted-foreground" data-changed-file-note="net">
                Edited {row.edits} times in this run. The journal keeps each edit on its own, so there is no single diff for the file; each edit is listed in order.
              </p>
            ) : null}
            {row?.truncated ? (
              <p className="text-xs text-muted-foreground" data-changed-file-note="truncated">
                The journal cut a long diff. The +/- counts were taken before the cut.
              </p>
            ) : null}
            <OpenFileThreadContext value={null}>
              <ol className="space-y-4">
                {edits.map((item, index) => (
                  <li key={item.id} data-changed-file-edit={item.id} data-edit-status={item.status} className="space-y-1.5">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-medium text-foreground">
                        Edit {index + 1} of {edits.length}
                      </span>
                      <span
                        className={cn(
                          "rounded-full border px-1.5 py-0.5 text-3xs",
                          item.status === "completed"
                            ? "border-border text-muted-foreground"
                            : item.status === "failed" || item.status === "cancelled" || item.status === "interrupted"
                              ? "border-destructive/25 bg-destructive/8 text-destructive"
                              : "border-border text-info",
                        )}
                      >
                        {STATUS_LABEL[item.status] ?? item.status}
                      </span>
                    </div>
                    <div className="text-xs">
                      <FileChangeDetail item={item} />
                    </div>
                  </li>
                ))}
              </ol>
            </OpenFileThreadContext>
          </>
        )}
      </div>
    </>
  );
}
