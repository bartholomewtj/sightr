import { NO_CAPABILITIES, type Project, type Thread, type ThreadEvent, type TurnItem } from "@shared/v2/contracts";

import type { ShellSnapshot, ThreadSnapshot } from "@/stream/wire";

export function project(id: string, over: Partial<Project> = {}): Project {
  return { id, label: `Space ${id}`, labelSource: "herd", number: 1, order: 0, status: "idle", ...over };
}

export function thread(id: string, over: Partial<Thread> = {}): Thread {
  return {
    id,
    paneId: `p-${id}`,
    terminalId: `term-${id}`,
    projectId: "w1",
    title: `Thread ${id}`,
    titleSource: "herd",
    harness: "claude",
    status: "idle",
    shelf: "active",
    unreadDone: false,
    lastActivityAt: 1_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    capabilities: NO_CAPABILITIES,
    ...over,
  };
}

export function userItem(id: string, threadId: string, text: string, ordinal = 0): TurnItem {
  return {
    id,
    threadId,
    runId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    type: "user_message",
    messageId: id,
    text,
    attachments: [],
  };
}

export function shellSnapshot(sequence: number, threads: Thread[] = [thread("t1")], projects: Project[] = [project("w1")]): ShellSnapshot {
  return { sequence, projects, threads, requests: [] };
}

export function threadSnapshot(sequence: number, t: Thread, items: TurnItem[] = []): ThreadSnapshot {
  return { sequence, thread: t, runs: [], items, requests: [], queue: [], historyCursor: null };
}

export function renamed(sequence: number, threadId: string, title: string): ThreadEvent {
  return { sequence, threadId, type: "thread.updated", payload: { patch: { title }, at: 2_000 + sequence }, ts: 2_000 + sequence };
}

export function itemEvent(sequence: number, item: TurnItem): ThreadEvent {
  return { sequence, threadId: item.threadId, type: "turn-item.updated", payload: { item }, ts: 2_000 + sequence };
}
