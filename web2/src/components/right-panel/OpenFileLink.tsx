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
import { createContext, use, type ReactNode } from "react";

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

/**
 * The thread whose Files tab a printed path opens in. The timeline provides it, so markdown deep in a
 * message (ChatMarkdown's inline code) can link a path without threading props; outside a thread
 * (null) paths stay plain text.
 */
export const OpenFileThreadContext = createContext<string | null>(null);

export function useOpenFileThread(): string | null {
  return use(OpenFileThreadContext);
}

/** Extensions an agent's bare file name (`notes.md`, `package.json`) carries; a dotted word (`e.g.`, `foo.bar()`) does not. */
const FILE_EXTENSIONS = new Set(
  "ts tsx js jsx mjs cjs json jsonl md mdx txt toml yaml yml css scss html htm py rs go java kt swift c h cc cpp hpp cs rb php sh ps1 bat sql xml svg png jpg jpeg gif webp lock env ini cfg conf log csv tsv vue svelte astro gradle proto graphql".split(
    " ",
  ),
);

/**
 * True when inline code an agent printed reads as a file path: no spaces or code punctuation, not a
 * URL, and either has a folder separator (`src/a.ts`, `C:\x\y`) or ends in a known file extension
 * (`notes.md`), with an optional `:line(:col)`. The bridge decides whether it can open.
 */
export function looksLikeFilePath(raw: string): boolean {
  const text = raw.trim();
  if (text.length < 3 || text.length > 300) return false;
  if (/\s|[()[\]{}<>=;"'`$|&*?!,@#^%+]/.test(text) || /:\/\//.test(text) || text.startsWith("-")) return false;
  const { path } = splitPathLine(text);
  if (/^\.{1,2}$/.test(path) || path.endsWith(".")) return false;
  const name = path.split(/[\\/]/).pop() ?? "";
  const ext = /\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(name)?.[1]?.toLowerCase();
  const hasSeparator = /[\\/]/.test(path) && /[A-Za-z0-9_]/.test(name);
  if (hasSeparator) return ext !== undefined || /^(?:\.{0,2}\/|[A-Za-z]:[\\/]|~\/)?[\w.-]+(?:[\\/][\w.-]+)+$/.test(path);
  return ext !== undefined && FILE_EXTENSIONS.has(ext) && /^[\w.-]+$/.test(name);
}

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
