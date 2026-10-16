import { NO_CAPABILITIES, type Project, type TurnItem } from "../../shared/v2/contracts.ts";
import type { EventDraft, ServerThread, TurnItemDraft } from "../threads/events.ts";

// Builders shared by the store and decide tests.

export function project(id = "w1", over: Partial<Project> = {}): Project {
  return { id, label: `ws ${id}`, labelSource: "herd", number: 1, order: 1, status: "idle", ...over };
}

export function thread(id = "t1", over: Partial<ServerThread> = {}): ServerThread {
  return {
    id,
    paneId: `w1:p-${id}`,
    terminalId: `term-${id}`,
    projectId: "w1",
    title: `thread ${id}`,
    titleSource: "herd",
    harness: "claude",
    status: "idle",
    shelf: "active",
    unreadDone: false,
    lastActivityAt: 1_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    capabilities: { ...NO_CAPABILITIES, hasJournal: true },
    ...over,
  };
}

export function textItem(id: string, threadId = "t1", runId: string | null = null, text = `text ${id}`): TurnItemDraft {
  return {
    id,
    threadId,
    runId,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    type: "assistant_message",
    messageId: id,
    text,
    streaming: false,
  } satisfies Omit<Extract<TurnItem, { type: "assistant_message" }>, "ordinal">;
}

export const createProject = (p = project()): EventDraft => ({ type: "project.upserted", payload: { project: p } });
export const createThread = (t = thread()): EventDraft => ({ type: "thread.created", threadId: t.id, payload: { thread: t } });
