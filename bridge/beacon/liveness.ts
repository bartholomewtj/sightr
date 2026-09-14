import { BEACON_TTL_MS } from "./types.ts";

// The TTL split, in one pure function and nowhere else.
//
// Upstream's precise liveness signal is a pid start time read out of `/proc/<pid>/stat`, which does
// not exist on Windows. So the heartbeat IS the signal here: every hook event stamps one, and a
// beacon nobody has stamped for half a day belongs to a session that is gone — a killed terminal, a
// closed lid, a machine that never got its `SessionEnd`.

/**
 * Whether a beacon stamped at `heartbeatMs` is still live at `now`.
 *
 * A heartbeat in the FUTURE is expired, not live. Clock skew and a hand-edited file both produce
 * one, and the closed reading is what stops a file claiming a heartbeat in 2099 from pinning a
 * status on a pane forever.
 */
export function beaconLiveness(
  heartbeatMs: number,
  now: number,
  ttlMs: number = BEACON_TTL_MS,
): "live" | "expired" {
  const age = now - heartbeatMs;
  if (age < 0) return "expired";
  return age <= ttlMs ? "live" : "expired";
}
