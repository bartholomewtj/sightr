/**
 * The Zustand stores the v2 streams fill. Components read them through selectors only and never see
 * raw events (T09):
 * - `useShell`: projects, threads and runtime-request summaries (the shell stream).
 * - `useThread(threadId)`: the one open thread (the thread stream).
 * - `useStreamHealth`: is the shell stream live, and is v2 refused on this host.
 */
import { create } from "zustand";

import { EMPTY_SHELL, type ShellState, type ThreadState } from "./apply";
import type { BlockingCode } from "./wire";

export const useShell = create<ShellState>(() => EMPTY_SHELL);

interface ThreadStore {
  /** The open thread's state, or null when no thread stream is open. */
  current: ThreadState | null;
  /** The bridge answered 404 for this thread id. */
  missing: string | null;
}

export const useThreadStore = create<ThreadStore>(() => ({ current: null, missing: null }));

/** The open thread, when it is `threadId`; null otherwise (another thread, or none). */
export function useThread(threadId: string | undefined): ThreadState | null {
  return useThreadStore((s) => (threadId && s.current?.threadId === threadId ? s.current : null));
}

export type StreamStatus = "connecting" | "live" | "lost";

export interface V2Blocked {
  code: BlockingCode;
  error: string;
  have?: string;
  need?: string;
}

export interface StreamHealth {
  status: StreamStatus;
  /** When the last frame of any kind arrived (ping included). */
  lastFrameAt: number | null;
  /** When the stream stopped being live (or the page opened); the banner times from here. */
  downSince: number;
  /** Frames dropped because they did not parse or did not fit their type. */
  dropped: number;
  /** Set while every v2 call answers a blocking 503 (`herdr-too-old`, `v2-disabled`). */
  blocked: V2Blocked | null;
}

const initialHealth = (): StreamHealth => ({
  status: "connecting",
  lastFrameAt: null,
  downSince: Date.now(),
  dropped: 0,
  blocked: null,
});

export const useStreamHealth = create<StreamHealth>(initialHealth);

export function noteDropped(): void {
  useStreamHealth.setState((s) => ({ dropped: s.dropped + 1 }));
}

export function setBlocked(blocked: V2Blocked): void {
  const prev = useStreamHealth.getState().blocked;
  if (prev && prev.code === blocked.code && prev.error === blocked.error && prev.have === blocked.have) return;
  useStreamHealth.setState({ blocked });
}

export function clearBlocked(): void {
  if (useStreamHealth.getState().blocked) useStreamHealth.setState({ blocked: null });
}

/** Test helper: every store back to its first state. */
export function __resetStreamStores(): void {
  useShell.setState(EMPTY_SHELL, true);
  useThreadStore.setState({ current: null, missing: null }, true);
  useStreamHealth.setState(initialHealth(), true);
}
