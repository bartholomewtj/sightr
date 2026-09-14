import { join } from "node:path";

// Where beacons live and what names them. Pure — this module computes paths, it never touches one.
//
// NO FILESYSTEM CALL LIVES ANYWHERE UNDER bridge/beacon/. The directory listing and the reads are a
// seam the reader is given (reader.ts `BeaconDirectory`), so every rule in this module is testable
// with no temp files, and the one place in the bridge allowed to touch a journal path stays
// bridge/journal/files.ts with its containment rule intact.

/** The beacon directory's name under the state dir. One directory, not a second state location. */
export const BEACONS_SUBDIR = "beacons";

/**
 * Owner-only, directory included.
 *
 * A beacon is not a credential, but anything that can WRITE one can name a pane's agent and its
 * session, so the directory is closed to everyone but its owner for the same reason a credential
 * store would be.
 */
export const BEACON_DIR_MODE = 0o700;
/** Owner-only, for the same reason. */
export const BEACON_FILE_MODE = 0o600;

/** The file suffix. Anything else in the directory is somebody else's and is skipped. */
export const BEACON_FILE_SUFFIX = ".json";

/**
 * The state directory, resolved exactly as the bridge resolves it: Herdr's injected dir, then
 * `SIGHTR_STATE_DIR`, then the default under the operator's home.
 *
 * It lives HERE, in a module with no filesystem and no config import, because the EMITTER runs
 * outside the bridge process and has to reach the same directory. Two copies of this rule would
 * agree today and drift later; `bridge/config.ts` calls this one.
 */
export function resolveStateDir(env: Record<string, string | undefined>, home: string): string {
  // A BLANK value is unset, not an empty path. The emitter runs inside whatever environment the
  // agent had, and a variable exported empty by a launcher would otherwise resolve to a RELATIVE
  // `beacons/` under the agent's own working directory — beacons scattered through the operator's
  // checkouts, and none of them where the bridge looks.
  const herdr = env.HERDR_PLUGIN_STATE_DIR?.trim();
  if (herdr) return herdr;
  const own = env.SIGHTR_STATE_DIR?.trim();
  if (own) return own;
  return join(home, ".local", "state", "sightr");
}

/**
 * `<stateDir>/beacons`.
 *
 * `stateDir` is a required argument rather than something this module resolves: the bridge already
 * has one on its config, and the emitter resolves its own with {@link resolveStateDir}.
 */
export function beaconsDir(stateDir: string): string {
  return join(stateDir, BEACONS_SUBDIR);
}

/**
 * The pane-id grammar. Herdr pane ids look like `w1:p1`.
 *
 * This is the whole defence of the file name: a value outside this shape is never written and never
 * read, so nothing that reaches a path here can carry a separator, a `..`, or a control character.
 */
const PANE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

/** Whether `raw` is a pane id we will name a file after. Pure — the whole decision. */
export function isPaneId(raw: string): boolean {
  return PANE_ID.test(raw);
}

/**
 * The file name a pane id is written under, or null when the id is not one we will name a file
 * after.
 *
 * `:` is the only character in the grammar that is illegal in an NTFS file name, so the encoding is
 * one substitution: `:` → `~`. `~` is NOT in the grammar, so the mapping is injective and
 * {@link paneIdOf} is its exact inverse.
 *
 * NTFS is case-insensitive, so two pane ids differing only in case would land on one file. That is
 * safe rather than wrong: the reader checks that a record's own `paneId` re-encodes to the file name
 * it was read from and skips it otherwise, so a collision degrades to "no beacon here".
 */
export function beaconFileName(paneId: string): string | null {
  if (!isPaneId(paneId)) return null;
  return `${paneId.replaceAll(":", "~")}${BEACON_FILE_SUFFIX}`;
}

/** The pane id behind a file name, or null when the name is not one of ours. */
export function paneIdOf(fileName: string): string | null {
  if (!fileName.endsWith(BEACON_FILE_SUFFIX)) return null;
  const paneId = fileName.slice(0, -BEACON_FILE_SUFFIX.length).replaceAll("~", ":");
  return isPaneId(paneId) ? paneId : null;
}
