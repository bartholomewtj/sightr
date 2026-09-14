// One-shot desktop arm request bridge. Armed state remains owned by the composer.
const listeners = new Set<() => void>();

export function onArmToggleRequest(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function requestArmToggle(): void {
  for (const fn of listeners) fn();
}

// Capture-phase desktop hotkeys run before the textarea handler, so they need this live flag.
// The armed state remains owned by the composer and is never persisted.
let armed = false;
export function setDirectArmed(on: boolean): void { armed = on; }
export function isDirectArmed(): boolean { return armed; }
export function __resetDirectArm(): void { armed = false; }
