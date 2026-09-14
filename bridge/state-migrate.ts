import { cp, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Sightr was published as "Sighter" before 1.0.0. A machine that ran the old plugin has its pins,
 * WebAuthn credentials, settings and push subscriptions under a state directory whose last path
 * segment says `sighter` (Herdr's `herdr.sighter`, or the bare default `~/.local/state/sighter`).
 *
 * This is the one-time bridge between the two: when the new state directory is missing or empty
 * and the old one exists, copy the old contents across. Nothing is deleted, nothing is merged into
 * a directory that already has state, and a directory whose name has no `sightr` in it (an operator
 * override) is left alone.
 */
export function legacyStateDir(stateDir: string): string | null {
  const name = basename(stateDir);
  if (!/sightr/i.test(name)) return null;
  const legacy = name.replace(/sightr/gi, (m) => (m === m.toUpperCase() ? "SIGHTER" : m[0] === "S" ? "Sighter" : "sighter"));
  return join(dirname(stateDir), legacy);
}

async function isMissingOrEmpty(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return true;
  }
}

async function isDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Returns the directory it copied from, or null when there was nothing to do. */
export async function migrateLegacyState(stateDir: string): Promise<string | null> {
  const legacy = legacyStateDir(stateDir);
  if (!legacy || legacy === stateDir) return null;
  if (!(await isDir(legacy)) || !(await isMissingOrEmpty(stateDir))) return null;
  await cp(legacy, stateDir, { recursive: true, force: false, errorOnExist: false });
  return legacy;
}
