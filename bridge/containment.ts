// Filesystem containment, shared by the bridge's two filesystem readers: the journal (session logs,
// bridge/journal/) and the Files tab (bridge/workdir*.ts, which may also save and delete; ADR 0026).
//
// The rule: a path is ours only if its REAL path, after symlink resolution, lies inside the REAL path
// of the root it was resolved through. Absent and refused are the same answer (null), so nothing the
// client sees can tell a containment failure from a missing file.

import { realpath } from "node:fs/promises";
import { sep } from "node:path";

/**
 * Resolve `candidate` and return it only if it is still inside `root` afterwards.
 *
 * The check runs on the REAL paths of both sides, which is the whole point: comparing the strings we
 * were handed would be satisfied by a symlink pointing anywhere. Null means "not ours to read" —
 * callers treat that identically to "not found", so a containment failure is never distinguishable from
 * an absent file by anything the client can see.
 */
export async function containedRealpath(candidate: string, root: string): Promise<string | null> {
  const real = await realpath(candidate).catch(() => null);
  const realRoot = await realpath(root).catch(() => null);
  if (real === null || realRoot === null) return null;
  return real === realRoot || real.startsWith(realRoot + sep) ? real : null;
}

/**
 * First root that really contains `candidate`, or null.
 *
 * ONLY for a path an adapter did not build — a session ref that arrived as a path (pi). Since no root
 * derived the name, the question is simply "does this file live in a journal we serve", and each root
 * answers for itself; the check per root is the same {@link containedRealpath} as everywhere else.
 * Never use this on a path built from a root: there the building root is the only one that may
 * contain it (journal/files.ts header).
 */
export async function containedRealpathIn(
  candidate: string,
  roots: readonly string[],
): Promise<string | null> {
  for (const root of roots) {
    const real = await containedRealpath(candidate, root);
    if (real !== null) return real;
  }
  return null;
}
