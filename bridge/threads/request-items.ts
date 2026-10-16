import type { RuntimeRequest, TurnItemStatus } from "../../shared/v2/contracts.ts";
import { requestQuestion } from "../../shared/v2/request-question.ts";
import type { EventDraft, TurnItemDraft } from "./events.ts";

// A runtime request shows in the thread's timeline as T3 shows one: an `approval_request` item
// (permission, trust, menu, password) or a `user_input_request` item (a question), keyed by the
// request id. The item is written in the same batch as every `runtime-request.updated`, so the two
// never disagree. Pure.

/** The timeline item id for a request. Stable, so each update replaces the one item. */
export function requestItemId(requestId: string): string {
  return `request:${requestId}`;
}

/** T3 keeps a waiting item `waiting`, an answered one `completed`, and an expired one `cancelled`. */
const ITEM_STATUS: Record<RuntimeRequest["status"], TurnItemStatus> = {
  pending: "waiting",
  resolved: "completed",
  expired: "cancelled",
};

/** The request's timeline item. No ordinal: a new item takes the next one, an update keeps its own. */
export function requestTurnItem(request: RuntimeRequest): TurnItemDraft {
  const base = {
    id: requestItemId(request.id),
    threadId: request.threadId,
    runId: request.runId ?? null,
    status: ITEM_STATUS[request.status],
    title: null,
    startedAt: request.createdAt,
    completedAt: request.status === "pending" ? null : request.updatedAt,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
  if (request.kind === "question") {
    return {
      ...base,
      type: "user_input_request",
      requestId: request.id,
      questions: [requestQuestion(request)],
    };
  }
  return {
    ...base,
    type: "approval_request",
    requestId: request.id,
    requestKind: request.kind,
    prompt: request.prompt,
    options: request.options.map((o) => ({ label: o.label })),
  };
}

/** The request event and its timeline item, as one batch. `boundText` stays on the bridge. */
export function requestEvents(request: RuntimeRequest, boundText?: string): EventDraft[] {
  return [
    {
      type: "runtime-request.updated",
      threadId: request.threadId,
      payload: boundText === undefined ? { request } : { request, boundText },
    },
    { type: "turn-item.updated", threadId: request.threadId, payload: { item: requestTurnItem(request) } },
  ];
}
