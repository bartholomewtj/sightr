// The Files tab's "unsaved edits" guard, reachable from the panel frame (T13): switching tabs, closing
// the panel or the phone sheet would unmount the editor, so they ask it first. One tab is mounted at a
// time, so one slot is enough.
type Guard = (go: () => void) => boolean;

let guard: Guard | null = null;

export function setPanelLeaveGuard(next: Guard | null): void {
  guard = next;
}

/** Run `go` now, unless the mounted tab holds dirty edits; it then asks and runs `go` on Discard. */
export function guardPanelLeave(go: () => void): void {
  if (guard?.(go)) return;
  go();
}
