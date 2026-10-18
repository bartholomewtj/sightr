// Back closes exactly one layer (T27). Sheets stack (the Diff panel's sheet, then its scope picker over it; a
// changed-file sheet over the thread) and every open sheet pushes its own history entry, so `popstate` is
// answered once, here, by the topmost slot only. Before, each `useSheetHistory` instance listened for itself,
// and one Back closed every sheet that was open.
//
// A "slot" is one history entry we pushed. It belongs to the sheet that pushed it (`owner`), or to nobody
// (an orphan) when that sheet closed while something was still above its entry (a sheet, or a route change):
// the browser cannot remove an entry from the middle of its list, so the slot stays. Each slot has an `id`,
// written into its entry's state, and `below`, the identity of the entry it was pushed on top of. An orphan is
// skipped (one more step back, so it never costs the operator an extra press) only when a Back lands exactly
// on `below`, that is, when that Back stepped off the orphan's entry. A pop that lands anywhere else (the
// router stepping from Z to Y over entries the orphan sits under) is the router's, and leaves it alone.
//
// Back with unsaved edits in the Files editor asks first (`guardPanelLeave`). If the guard holds the close,
// our entry is already gone: it is pushed again so the next Back still closes the sheet instead of leaving
// the thread.
import { useEffect, useRef } from "react";

import { guardPanelLeave } from "./right-panel/leaveGuard";

const SHEET_STATE = "sightrSheet";

interface SheetOwner {
  close: () => void;
  slot: Slot | null;
}
interface Slot {
  id: number;
  owner: SheetOwner | null;
  /** The entry this one was pushed on top of (`entryKey` of its state). */
  below: string;
}
const slots: Slot[] = [];
/** Back steps we took ourselves (closing the top sheet by hand): their `popstate` is not a gesture. */
const ownPops = new Set<object>();
let listening = false;

let nextSlotId = 1;

/** What names a history entry: its state (the router's entries carry a key of their own, ours a `sheetId`). */
const entryKey = (state: unknown): string => JSON.stringify(state ?? null);
const sheetIdOf = (state: unknown): number | null => {
  const id = (state as Record<string, unknown> | null)?.sheetId;
  return typeof id === "number" ? id : null;
};

function pushSlot(owner: SheetOwner): Slot {
  const slot: Slot = { id: nextSlotId++, owner, below: entryKey(window.history.state) };
  window.history.pushState({ ...(window.history.state as object | null), [SHEET_STATE]: true, sheetId: slot.id }, "");
  slots.push(slot);
  if (!listening) {
    listening = true;
    window.addEventListener("popstate", onPopState);
  }
  return slot;
}

function onPopState(): void {
  const mine = ownPops.values().next();
  if (!mine.done) {
    ownPops.delete(mine.value);
    return;
  }
  const top = slots[slots.length - 1];
  if (!top) return; // somebody else's entry: the router's
  const owner = top.owner;
  if (owner === null) {
    // An orphan: its sheet is long gone. When this Back stepped off its entry, it was meant for whatever lies
    // below: step once more. Any other pop is the router's own, and the orphan keeps its place.
    if (entryKey(window.history.state) === top.below) {
      slots.pop();
      window.history.back();
    }
    return;
  }
  slots.pop();
  owner.slot = null;
  let closed = false;
  guardPanelLeave(() => {
    closed = true;
    owner.close();
  });
  if (!closed) owner.slot = pushSlot(owner);
}

/** The sheet closed by other means (X, Escape, backdrop, unmount): take its entry back off if it is the top one. */
function releaseSlot(owner: SheetOwner): void {
  const slot = owner.slot;
  if (!slot) return;
  owner.slot = null;
  const top = slots[slots.length - 1] === slot;
  // Only the entry we are on can be stepped off; after a route change it is not ours any more.
  if (top && sheetIdOf(window.history.state) === slot.id) {
    slots.pop();
    const token = {};
    ownPops.add(token);
    // If the browser never reports this step (nothing to go back to), it must not swallow a real gesture later.
    setTimeout(() => ownPops.delete(token), 1_500);
    window.history.back();
  } else {
    slot.owner = null;
  }
}

/** Test helper: forget every slot (the real history is the test's to reset). */
export function __resetSheetHistory(): void {
  slots.length = 0;
  ownPops.clear();
  if (listening) window.removeEventListener("popstate", onPopState);
  listening = false;
}

/** How many history entries sheets hold right now (tests, and a sanity check that none leaks). */
export function openSheetEntries(): number {
  return slots.length;
}

/**
 * One history entry while a sheet is open. Back pops it (and closes the sheet) instead of leaving the
 * thread, and only the sheet opened last answers, so one Back closes one layer; closing the sheet any
 * other way pops the entry it pushed.
 */
export function useSheetHistory(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const owner: SheetOwner = { close: () => closeRef.current(), slot: null };
    owner.slot = pushSlot(owner);
    return () => releaseSlot(owner);
  }, [open]);
}
