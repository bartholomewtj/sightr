// The palette's "Messages" group: text search across every thread's user and assistant messages and
// command inputs (`GET /api/v2/search`). Same shape as the Open file… search beside it: starts after the
// minimum characters, waits 200 ms for the typing to stop, and aborts a superseded request.
import { useEffect, useState } from "react";

import type { ThreadSearchMatch } from "@shared/v2/contracts";
import { searchThreads } from "@/lib/api";

import { MESSAGE_SEARCH_LIMIT, MESSAGE_SEARCH_MIN_CHARS } from "./CommandPalette.logic";

export const MESSAGE_SEARCH_DEBOUNCE_MS = 200;

export interface MessageSearch {
  matches: ThreadSearchMatch[];
  /** A request is waiting or in flight for the current query. */
  pending: boolean;
  /** Plain words for the empty state, else null. A bridge without the route stays silent. */
  error: string | null;
}

const IDLE: MessageSearch = { matches: [], pending: false, error: null };

export function messageSearchErrorMessage(err: unknown): string | null {
  const status = (err as { status?: number } | null)?.status;
  // 404/503: an older bridge, or v2 off. The group is simply absent.
  if (status === 404 || status === 503) return null;
  return "Message search failed.";
}

export function useMessageSearch(query: string, enabled: boolean): MessageSearch {
  const trimmed = query.trim();
  const active = enabled && trimmed.length >= MESSAGE_SEARCH_MIN_CHARS;
  const [state, setState] = useState<MessageSearch>(IDLE);
  useEffect(() => {
    if (!active) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    setState({ matches: [], pending: true, error: null });
    const timer = setTimeout(() => {
      searchThreads(trimmed, controller.signal, MESSAGE_SEARCH_LIMIT)
        .then((r) => {
          if (controller.signal.aborted) return;
          setState({ matches: r.results, pending: false, error: null });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setState({ matches: [], pending: false, error: messageSearchErrorMessage(err) });
        });
    }, MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, trimmed]);
  return state;
}
