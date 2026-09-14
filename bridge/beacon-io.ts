import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { beaconsDir, BEACON_FILE_SUFFIX } from "./beacon/paths.ts";
import type { BeaconDirectory, BeaconSweepDeps } from "./beacon/reader.ts";

// THE BEACON SEAM, IN ITS REAL IMPLEMENTATION — the filesystem half that `bridge/beacon/` refuses to
// hold. Everything under that directory is pure by rule; this module is where its one seam is
// filled, and it sits OUTSIDE that directory so the rule stays greppable rather than remembered.
//
// IT READS AND IT NEVER WRITES. Nothing here can cause a send, a key, a rename or a close — a
// beacon is a hint, never a control channel (beacon/types.ts).
//
// EVERY FAILURE IS THE SAME FAILURE: an absent directory (the ordinary first-run case), an
// unreadable file, a file that vanished mid-sweep, something that is not a regular file — each
// answers `null`, which the reader already reads as "there is no beacon here".

/** The beacon directory on disk, as the reader's seam. */
export function fileBeaconDirectory(stateDir: string): BeaconDirectory {
  const dir = beaconsDir(stateDir);
  return {
    async list(): Promise<readonly string[] | null> {
      try {
        const names = await readdir(dir);
        return names.filter((name) => name.endsWith(BEACON_FILE_SUFFIX));
      } catch {
        return null;
      }
    },
    async read(name: string): Promise<string | null> {
      // The name comes from our own listing and has already been checked against the pane-id grammar
      // by the reader, but it is joined HERE and nowhere else — nothing outside this module ever
      // supplies one.
      const path = join(dir, name);
      try {
        // `lstat`, never `stat`: a symlink in the beacon directory is somebody redirecting a read,
        // and the honest answer to it is the same as to an absent file. On Windows a junction
        // reports as a symlink through `lstat`, which is the behaviour we want.
        const stats = await lstat(path);
        if (!stats.isFile()) return null;
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** The sweep dependencies the bridge hands `readBeacons` — the disk, and the real clock. */
export function beaconReader(stateDir: string): BeaconSweepDeps {
  return { directory: fileBeaconDirectory(stateDir) };
}
