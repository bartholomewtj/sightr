import type {
  EventPayloads,
  RuntimeRequest,
  Thread,
  ThreadEvent,
  ThreadEventType,
  ThreadPatch,
  TurnItem,
  WireSessionRef,
} from "../../shared/v2/contracts.ts";
import type { AgentSessionRef } from "../journal/types.ts";

// The server-side forms of the v2 events. They differ from the wire forms in `shared/v2/contracts.ts`
// in exactly two places, both things a browser must never see: a session ref may be a `path`, and a
// runtime request carries the screen text it was bound to. `toWireEvent` is the one place that strips
// them; the store applies it to every event it hands out.

/** The thread as the store keeps it: the full session ref, path refs included. */
export type ServerThread = Omit<Thread, "sessionRef"> & { sessionRef?: AgentSessionRef };
export type ServerThreadPatch = Omit<ThreadPatch, "sessionRef"> & { sessionRef?: AgentSessionRef | null };

type DraftOf<I> = I extends TurnItem ? Omit<I, "ordinal"> & { ordinal?: number } : never;
/** A turn item before the store has given it an ordinal (a new item takes the next one). */
export type TurnItemDraft = DraftOf<TurnItem>;

export interface ServerEventPayloads
  extends Omit<EventPayloads, "thread.created" | "thread.updated" | "turn-item.updated" | "runtime-request.updated"> {
  "thread.created": { thread: ServerThread };
  "thread.updated": { patch: ServerThreadPatch; at: number };
  "turn-item.updated": { item: TurnItemDraft };
  /** `boundText` is the screen region the request was parsed from (T04). Server-side only. */
  "runtime-request.updated": { request: RuntimeRequest; boundText?: string };
}

export type EventDraftOf<T extends ThreadEventType> = {
  type: T;
  /** The thread the event belongs to; project and global events have none. */
  threadId?: string;
  payload: ServerEventPayloads[T];
};
export type EventDraft = { [K in ThreadEventType]: EventDraftOf<K> }[ThreadEventType];

export type StoredEventOf<T extends ThreadEventType> = EventDraftOf<T> & {
  sequence: number;
  commandId?: string;
  ts: number;
};
export type StoredEvent = { [K in ThreadEventType]: StoredEventOf<K> }[ThreadEventType];

/** An id ref passes; a path ref (or none) does not reach a client. */
export function wireSessionRef(ref: AgentSessionRef | null | undefined): WireSessionRef | undefined {
  return ref?.kind === "id" ? { kind: "id", value: ref.value } : undefined;
}

export function toWireThread(thread: ServerThread): Thread {
  const { sessionRef, ...rest } = thread;
  const wire = wireSessionRef(sessionRef);
  return wire ? { ...rest, sessionRef: wire } : rest;
}

/** The client form of a stored event: path refs and bound text removed. */
export function toWireEvent(event: StoredEvent): ThreadEvent {
  switch (event.type) {
    case "thread.created":
      return { ...event, payload: { thread: toWireThread(event.payload.thread) } };
    case "thread.updated": {
      const { sessionRef, ...patch } = event.payload.patch;
      // A path ref on the server reads as "no id ref" on the wire, so it clears the client's copy.
      const wirePatch: ThreadPatch =
        sessionRef === undefined ? patch : { ...patch, sessionRef: wireSessionRef(sessionRef) ?? null };
      return { ...event, payload: { patch: wirePatch, at: event.payload.at } };
    }
    case "runtime-request.updated":
      return { ...event, payload: { request: event.payload.request } };
    case "turn-item.updated":
      // The store fills `ordinal` before it writes the event, so a stored item is complete.
      return { ...event, payload: { item: event.payload.item as TurnItem } };
    default:
      return event;
  }
}
