import type { Command, Project } from "../../shared/v2/contracts.ts";
import type { EventDraft, ServerThread } from "./events.ts";

// Commands → events, as a pure function. No I/O, no clock, no random source: the caller passes the
// rows the command needs and a context with `now` and `newId`, so the same input always gives the same
// decision. This slice decides the commands that only change the projection; every other command type
// is `unsupported` here and T05 routes it to its effect handler (T06–T08).

export const MAX_TITLE_LENGTH = 200;

export interface DecideState {
  /** The command's thread, when it names one. */
  thread?: ServerThread | null;
  /** The command's project, when it names one. */
  project?: Project | null;
  /** Whether the thread's pane still exists in herdr (unarchive needs it). */
  paneAlive: boolean;
  /** The highest `pinOrder` among pinned threads (`store.maxPinOrder()`), for a new pin. */
  maxPinOrder?: number;
}

export interface DecideContext {
  now: number;
  newId: () => string;
}

export type DecisionCode = "not_found" | "invalid" | "conflict";

export type Decision =
  | { ok: true; events: EventDraft[]; result?: unknown }
  | { ok: false; reason: string; code: DecisionCode };

const reject = (code: DecisionCode, reason: string): Decision => ({ ok: false, code, reason });
const accept = (...events: EventDraft[]): Decision => ({ ok: true, events });

export function decide(state: DecideState, command: Command, ctx: DecideContext): Decision {
  const at = ctx.now;
  switch (command.type) {
    case "project.rename": {
      const project = state.project;
      if (!project || project.id !== command.projectId) return reject("not_found", "no-such-project");
      const label = command.label.trim();
      if (!label) return reject("invalid", "empty-label");
      if (label.length > MAX_TITLE_LENGTH) return reject("invalid", "label-too-long");
      return accept({ type: "project.upserted", payload: { project: { ...project, label, labelSource: "user" } } });
    }
    case "thread.rename":
    case "thread.pin":
    case "thread.unpin":
    case "thread.snooze":
    case "thread.unsnooze":
    case "thread.settle":
    case "thread.unsettle":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.markRead":
    case "thread.markUnread":
      break;
    default:
      return reject("invalid", "unsupported");
  }

  const thread = state.thread;
  if (!thread || thread.id !== command.threadId) return reject("not_found", "no-such-thread");
  const threadId = thread.id;
  const archived = thread.shelf === "archived";

  switch (command.type) {
    case "thread.rename": {
      const title = command.title.trim();
      if (!title) return reject("invalid", "empty-title");
      if (title.length > MAX_TITLE_LENGTH) return reject("invalid", "title-too-long");
      if (archived) return reject("conflict", "archived");
      return accept({ type: "thread.updated", threadId, payload: { patch: { title, titleSource: "user" }, at } });
    }
    case "thread.pin": {
      if (archived) return reject("conflict", "archived");
      const wanted = command.pinOrder;
      if (wanted !== undefined && !Number.isFinite(wanted)) return reject("invalid", "bad-pin-order");
      if (thread.shelf === "pinned" && (wanted === undefined || wanted === thread.pinOrder)) return accept();
      return accept({
        type: "thread.shelf-changed",
        threadId,
        payload: { shelf: "pinned", pinOrder: wanted ?? (state.maxPinOrder ?? 0) + 1, at },
      });
    }
    case "thread.unpin":
      if (thread.shelf !== "pinned") return accept();
      return accept({ type: "thread.shelf-changed", threadId, payload: { shelf: "active", at } });
    case "thread.snooze":
      if (!Number.isFinite(command.until)) return reject("invalid", "bad-time");
      if (command.until <= at) return reject("invalid", "snooze-in-past");
      if (archived) return reject("conflict", "archived");
      return accept({ type: "thread.shelf-changed", threadId, payload: { shelf: "snoozed", snoozedUntil: command.until, at } });
    case "thread.unsnooze":
      if (thread.shelf !== "snoozed") return accept();
      return accept({ type: "thread.shelf-changed", threadId, payload: { shelf: "active", at } });
    case "thread.settle":
      if (archived) return reject("conflict", "archived");
      if (thread.shelf === "settled") return accept();
      return accept({ type: "thread.shelf-changed", threadId, payload: { shelf: "settled", at } });
    case "thread.unsettle":
      if (thread.shelf !== "settled") return accept();
      return accept({ type: "thread.shelf-changed", threadId, payload: { shelf: "active", at } });
    case "thread.archive":
      if (archived) return accept();
      return accept({ type: "thread.archived", threadId, payload: { reason: "user", at } });
    case "thread.unarchive":
      if (!archived) return accept();
      if (!state.paneAlive) return reject("conflict", "pane-closed");
      return accept({ type: "thread.shelf-changed", threadId, payload: { shelf: "active", at } });
    case "thread.markRead":
      if (!thread.unreadDone) return accept();
      return accept({ type: "thread.updated", threadId, payload: { patch: { unreadDone: false }, at } });
    case "thread.markUnread":
      if (thread.unreadDone) return accept();
      return accept({ type: "thread.updated", threadId, payload: { patch: { unreadDone: true }, at } });
  }
}
