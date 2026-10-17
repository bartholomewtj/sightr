// The palette's "Open file…" search: the Files tab's own endpoint (`/api/files/search`, names under the
// work root, refused names already filtered by the bridge), debounced the way the Files tab does it, with
// a superseded query aborted. Rel paths only; the picker never builds a path of its own.
import { useEffect, useState } from "react";

import type { FileSearchResult } from "@shared/wire";
import { searchFiles } from "@/lib/api";
import { isDeletedFile } from "@/lib/files-tree";

import { FILE_SEARCH_MIN_CHARS } from "./CommandPalette.logic";

export const FILE_SEARCH_DEBOUNCE_MS = 200;

export interface FilePickerSearch {
  results: FileSearchResult[];
  truncated: boolean;
  pending: boolean;
  /** Plain words for the empty state, else null. */
  error: string | null;
  /** Fewer than the minimum characters typed. */
  tooShort: boolean;
}

/** The words for a failed search: Files off (404), a timeout, anything else. */
export function fileSearchErrorMessage(err: unknown): string {
  if ((err as { status?: number } | null)?.status === 404) return "Files isn't turned on. Set SIGHTR_WORK_ROOT on the host.";
  if (err instanceof Error && /time|abort/i.test(`${err.name} ${err.message}`)) return "Search took too long. Try a longer name.";
  return "Search failed.";
}

export function useFilePickerSearch(query: string, enabled: boolean): FilePickerSearch {
  const trimmed = query.trim();
  const tooShort = trimmed.length < FILE_SEARCH_MIN_CHARS;
  const [state, setState] = useState<{ results: FileSearchResult[]; truncated: boolean; pending: boolean; error: string | null }>({
    results: [],
    truncated: false,
    pending: false,
    error: null,
  });
  useEffect(() => {
    if (!enabled || tooShort) {
      setState({ results: [], truncated: false, pending: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ ...s, results: [], pending: true, error: null }));
    const timer = setTimeout(() => {
      searchFiles(trimmed, controller.signal)
        .then((r) => {
          if (controller.signal.aborted) return;
          setState({ results: r.results.filter((x) => !isDeletedFile(x.path)), truncated: r.truncated, pending: false, error: null });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setState({ results: [], truncated: false, pending: false, error: fileSearchErrorMessage(err) });
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, tooShort, trimmed]);
  return { ...state, tooShort };
}
