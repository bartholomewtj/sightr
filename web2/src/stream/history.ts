/**
 * Older runs of a thread: `GET /api/v2/thread/:id/history?before=<cursor>&limit=` (T05). T11 pages
 * the timeline with it. Timed as a `read` for `sightr-ctl conn`.
 */
import { timedFetch } from "@v1/lib/conn-telemetry";

import { noteIfLocked, XHR_HEADER, XHR_HEADER_VALUE } from "@/lib/api";

import { v2HistoryPath, type HistoryPage } from "./wire";

export async function fetchThreadHistory(
  threadId: string,
  before: string | null,
  limit?: number,
  signal?: AbortSignal,
): Promise<HistoryPage> {
  const q = new URLSearchParams();
  if (before) q.set("before", before);
  if (limit !== undefined) q.set("limit", String(limit));
  const qs = q.toString();
  const res = await timedFetch("read", () =>
    fetch(`${v2HistoryPath(threadId)}${qs ? `?${qs}` : ""}`, { headers: { [XHR_HEADER]: XHR_HEADER_VALUE }, signal }),
  );
  if (!res.ok) {
    noteIfLocked(res);
    throw new Error(`history -> ${res.status}`);
  }
  return (await res.json()) as HistoryPage;
}
