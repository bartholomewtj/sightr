/**
 * "Open a file from anywhere": a path an agent printed (absolute, or relative to the thread's folder)
 * as a tappable link that opens it in the Files tab (the desktop panel, or the sheet on a phone). The
 * bridge maps the path into the Files root (`/api/files/resolve`, relInRoot); the client never sees an
 * absolute root, and a path outside the root or hidden by the Files rules is refused with a toast.
 *
 * For the timeline to adopt (tool rows, `file_change` items, WorkLog path chips): render
 * `<OpenFileLink threadId={id} path={raw} />`, or call `openPrintedPath(threadId, raw)` from an
 * existing control. A known Files rel path skips the bridge: `useRightPanelStore.getState().openFile`.
 */
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { showToast } from "@/components/toast";
import { resolveFilePath } from "@/lib/api";
import { useRightPanelStore } from "@/rightPanelStore";
import { useSidebarThread } from "@/state/sidebar";
import { useThread } from "@/stream/stores";
import type { FileResolveResponse } from "@shared/wire";

export const RESOLVE_REFUSED: Record<Extract<FileResolveResponse, { path: null }>["reason"], string> = {
  "outside-root": "That file is outside the Files root, so it can't open here.",
  hidden: "Files keeps that file hidden (dot files, secrets, dependencies).",
  "not-found": "That file isn't there any more.",
  "no-folder": "This thread's folder isn't known, so a relative path can't be found.",
  "bad-path": "That doesn't look like a file path.",
};

/** `src/a.ts:12:3` → `{ path: "src/a.ts", line: 12 }`. A Windows drive colon is never taken for a line. */
export function splitPathLine(raw: string): { path: string; line?: number } {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(raw.trim());
  if (!m || !m[1] || /^[A-Za-z]$/.test(m[1])) return { path: raw.trim() };
  return { path: m[1], line: Number(m[2]) };
}

/** Resolve a printed path for this thread's pane and open it in Files, or say why it can't open. */
export async function openPrintedPath(threadId: string, paneId: string | null, raw: string): Promise<boolean> {
  const { path } = splitPathLine(raw);
  try {
    const res = await resolveFilePath(paneId, path);
    if (res.path === null) {
      showToast(RESOLVE_REFUSED[res.reason], "error");
      return false;
    }
    useRightPanelStore.getState().openFile(threadId, res.path, res.kind);
    return true;
  } catch (err) {
    showToast((err as { status?: number }).status === 404 ? "Files isn't turned on. Set SIGHTR_WORK_ROOT on the host." : "Couldn't open that file.", "error");
    return false;
  }
}

export function OpenFileLink({ threadId, path, children, className }: { threadId: string; path: string; children?: ReactNode; className?: string }) {
  const state = useThread(threadId);
  const shellThread = useSidebarThread(threadId);
  const paneId = (state?.thread ?? shellThread)?.paneId || null;
  return (
    <button
      type="button"
      data-open-file={path}
      title={`Open ${path} in Files`}
      onClick={(e) => {
        e.stopPropagation();
        void openPrintedPath(threadId, paneId, path);
      }}
      className={cn("inline cursor-pointer text-left font-mono wrap-anywhere underline decoration-dotted underline-offset-2 hover:text-foreground", className)}
    >
      {children ?? path}
    </button>
  );
}
