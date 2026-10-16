/**
 * Shell-stream events as they arrive, for the few callers that act on one event rather than on the
 * store it updates: T14's draft matches `thread.created` and `project.upserted` to its own
 * `commandId`, and reads `thread.create.failed`, which changes no store. A snapshot carries no events,
 * so a listener must also be able to work from `useShell` alone.
 */
import type { ThreadEvent } from "@shared/v2/contracts";

type Listener = (event: ThreadEvent) => void;

const listeners = new Set<Listener>();

export function onShellEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by the shell stream once per new event (after the store applied it). */
export function emitShellEvent(raw: unknown): void {
  const event = raw as Partial<ThreadEvent> | null;
  if (!event || typeof event.type !== "string" || typeof event.sequence !== "number") return;
  for (const listener of [...listeners]) {
    try {
      listener(event as ThreadEvent);
    } catch {
      // one bad listener must not stop the stream
    }
  }
}
