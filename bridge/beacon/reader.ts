import { beaconLiveness } from "./liveness.ts";
import { parseBeacon } from "./parse.ts";
import { beaconFileName, paneIdOf } from "./paths.ts";
import type { BeaconReading } from "./types.ts";

// THE SWEEP — one pass over the beacon directory, turning files into readings.
//
// The directory is a SEAM, not a filesystem call: the real implementation lives in
// ../beacon-io.ts, outside this directory, so the "nothing under bridge/beacon/ touches the disk"
// rule stays greppable rather than remembered, and every rule below is unit-testable with an
// in-memory map.
//
// TOTAL OVER GARBAGE. An unlistable directory, a foreign file, a torn write, a newer schema, a read
// that failed mid-sweep — each is skipped and the sweep carries on. A directory of nothing but
// garbage yields an empty list and never throws. None of these may take the herd view down: the
// beacon is an improvement on guessing, and an improvement that can break the herd list is not one.

/** The directory, as a seam. Both methods answer `null` rather than throwing. */
export interface BeaconDirectory {
  /** The file names in the directory, or null when it cannot be listed at all. */
  list(): Promise<readonly string[] | null>;
  /** One file's text, or null when it is gone, unreadable, or not a regular file. */
  read(name: string): Promise<string | null>;
}

/** Everything {@link readBeacons} needs. `now` and `ttlMs` are injected for tests. */
export interface BeaconSweepDeps {
  readonly directory: BeaconDirectory;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

/**
 * Read every beacon in the directory, newest state per pane, sorted by pane id.
 *
 * The file-name check in the middle is not a formality: it is what stops a beacon copied to a second
 * name from presenting one pane's identity as another's, and what makes an NTFS case collision
 * degrade to "no beacon here" instead of to the wrong pane's session.
 */
export async function readBeacons(deps: BeaconSweepDeps): Promise<readonly BeaconReading[]> {
  const now = (deps.now ?? Date.now)();
  let names: readonly string[] | null;
  try {
    names = await deps.directory.list();
  } catch {
    return [];
  }
  if (names === null) return [];

  const readings: BeaconReading[] = [];
  for (const name of names) {
    if (paneIdOf(name) === null) continue; // not one of ours
    let text: string | null;
    try {
      text = await deps.directory.read(name);
    } catch {
      continue; // a read that failed mid-sweep is the same as an absent file
    }
    if (text === null) continue;

    const record = parseBeacon(text);
    if (record === null) continue;
    if (beaconFileName(record.paneId) !== name) continue;

    const { paneId, harness, session, sessionName } = record;
    const common = { paneId, harness, session, ...(sessionName === undefined ? {} : { sessionName }) };
    // The status is DROPPED here rather than carried and ignored downstream, so there is no way to
    // read a stale status by accident.
    readings.push(
      beaconLiveness(record.heartbeatMs, now, deps.ttlMs) === "live"
        ? { liveness: "live", ...common, status: record.status }
        : { liveness: "expired", ...common },
    );
  }

  return readings.sort((a, b) => a.paneId.localeCompare(b.paneId));
}
