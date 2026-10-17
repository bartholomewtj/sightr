/**
 * "Woke": a thread whose snooze ran out while it was away. The bridge wakes it (shelf `active`, `snoozedUntil`
 * cleared) and keeps no trace, so the device remembers what it saw: each thread it saw snoozed, with its wake
 * time. When a remembered thread turns up active at or after that time, it woke by itself and wears "Woke"
 * until it is opened. A wake the operator did by hand ("Wake now", an earlier time than `snoozedUntil`), and a
 * thread moved to another shelf, never gets the label. The memory is per device (localStorage), so a wake that
 * happened while the app was closed still shows on the next open. No bridge state.
 */
import { useEffect } from "react";
import { create } from "zustand";

import type { Thread } from "@shared/v2/contracts";

const KEY = "sightr:v2:woke:v1";
/** The bridge wakes on its next poll after `snoozedUntil`; a little early is clock skew, not a manual wake. */
export const WAKE_SLACK_MS = 5_000;
/** A label nobody opened goes after this long. */
export const WOKE_TTL_MS = 12 * 60 * 60 * 1_000;

export interface WokeMemory {
  /** threadId → the `snoozedUntil` it was last seen with. */
  snoozed: Record<string, number>;
  /** threadId → when the device noticed it had woken. */
  woke: Record<string, number>;
}

const EMPTY: WokeMemory = { snoozed: {}, woke: {} };

/** The memory after seeing `threads` at `now`. Pure. */
export function noteWokeTransitions(memory: WokeMemory, threads: Readonly<Record<string, Thread>>, now: number): WokeMemory {
  const snoozed: Record<string, number> = {};
  const woke: Record<string, number> = {};
  for (const [id, at] of Object.entries(memory.woke)) {
    const t = threads[id];
    if (t && t.shelf === "active" && now - at < WOKE_TTL_MS) woke[id] = at;
  }
  for (const t of Object.values(threads)) {
    if (t.shelf === "snoozed" && t.snoozedUntil !== undefined) {
      snoozed[t.id] = t.snoozedUntil;
      delete woke[t.id];
      continue;
    }
    const until = memory.snoozed[t.id];
    if (until !== undefined && t.shelf === "active" && until <= now + WAKE_SLACK_MS) woke[t.id] = now;
  }
  return { snoozed, woke };
}

function read(): WokeMemory {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<WokeMemory> | null;
    const numbers = (v: unknown): Record<string, number> =>
      v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === "number")) as Record<string, number> : {};
    return parsed ? { snoozed: numbers(parsed.snoozed), woke: numbers(parsed.woke) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function write(memory: WokeMemory): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* private mode: the memory lives for this page only */
  }
}

export const useWoke = create<WokeMemory>(() => read());

const same = (a: Record<string, number>, b: Record<string, number>) => {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
};

/** Take the shell's threads in. Call only once the shell has loaded: an empty first snapshot would forget everything. */
export function observeWoke(threads: Readonly<Record<string, Thread>>, now: number = Date.now()): void {
  const current = useWoke.getState();
  const next = noteWokeTransitions(current, threads, now);
  if (same(next.snoozed, current.snoozed) && same(next.woke, current.woke)) return;
  useWoke.setState(next, true);
  write(next);
}

/** Opening the thread is the acknowledgement. */
export function clearWoke(threadId: string): void {
  const current = useWoke.getState();
  if (current.woke[threadId] === undefined) return;
  const { [threadId]: _gone, ...woke } = current.woke;
  const next = { snoozed: current.snoozed, woke };
  useWoke.setState(next, true);
  write(next);
}

export function useWokeTracking(loaded: boolean, threads: Readonly<Record<string, Thread>>, openThreadId: string | undefined): void {
  useEffect(() => {
    if (loaded) observeWoke(threads);
  }, [loaded, threads]);
  useEffect(() => {
    if (openThreadId) clearWoke(openThreadId);
  }, [openThreadId, threads]);
}

/** Test helper. */
export function __resetWoke(): void {
  useWoke.setState({ snoozed: {}, woke: {} }, true);
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
