// What the host OS can do, for tests that assert POSIX-only guarantees.
//
// Sightr deploys to Linux and macOS, and is developed on Windows too. Two facilities the suite
// leans on do not exist there:
//
//   * File modes. Windows has no owner/group/other permission bits, so a file written with mode
//     0600 reads back as 0666. An "owner-only" assertion can never pass.
//   * Symlinks. Creating one needs Developer Mode or an elevated process; without either, the
//     syscall fails with EPERM before the test under it gets to run.
//
// Tests that depend on either are skipped on such a host rather than deleted or weakened — the
// guarantee still holds where Sightr actually runs, and CI (ubuntu-latest) executes every one of
// them. Nothing else gets a pass: any other test must hold on all three platforms, which mostly
// means building paths with join() rather than interpolating "/" into a string.

import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** True where a file's mode bits mean something — i.e. not Windows. */
export const POSIX_MODES = process.platform !== "win32";

/**
 * True where this process may create symlinks. Probed rather than inferred from the platform: a
 * Windows box with Developer Mode on can make them, and should run those tests like any other host.
 */
export const CAN_SYMLINK = probeSymlinks();

function probeSymlinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "sightr-symlink-probe-"));
  try {
    // A dangling target is fine — POSIX allows it, and Windows refuses at the privilege check
    // before it ever looks at the target. Either way the answer arrives without touching real files.
    symlinkSync(join(dir, "target"), join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
