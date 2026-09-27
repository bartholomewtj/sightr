import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { legacyStateDir } from "../../bridge/state-migrate.ts";
import { parseEnv } from "./env.ts";

// Sightr was published as "Sighter" before 1.0.0, and its operator config lived in
// `herdr.sighter/.env` (or `~/.config/sighter/.env`). The state dir was already copied across on
// rename (bridge/state-migrate.ts); this is the same one-time bridge for the config, so VAPID,
// TRUSTED_USER, DEVICE_HEADER and PUBLIC_HOSTS keep applying after the plugin-id change (spec 11).
//
// Rules, as for state: nothing deleted, nothing merged into a dir that already has a `.env`. The
// copy renames `SIGHTER_*` keys to `SIGHTR_*` once; nothing reads the old names at runtime.

const LEGACY_PREFIX = /^(\s*(?:export\s+)?)SIGHTER_/;

/** Where a pre-1.0 config may live, nearest first. */
export function legacyConfigDirs(configDir: string, home: string): string[] {
  const dirs = [legacyStateDir(configDir), path.join(home, ".config", "sighter")];
  return [...new Set(dirs.filter((d): d is string => d !== null && d !== configDir))];
}

/** Rename `SIGHTER_*` keys to `SIGHTR_*`, prefix only; every other line is kept byte for byte. */
export function rewriteSighterKeys(text: string): { text: string; renamed: string[] } {
  const renamed: string[] = [];
  const out = text
    .split("\n")
    .map((line) => {
      const m = LEGACY_PREFIX.exec(line);
      if (!m) return line;
      const key = line.slice(m[1]!.length).split("=")[0]!.trim();
      renamed.push(key);
      return line.replace(LEGACY_PREFIX, `${m[1]}SIGHTR_`);
    })
    .join("\n");
  return { text: out, renamed };
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function isMissingOrEmpty(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return true;
  }
}

/**
 * Copy a pre-1.0 `.env` into `configDir` when it has none. Returns the directory it copied from,
 * or null when there was nothing to do. `commands.toml` / `keys.toml` come too, but only into an
 * empty directory, where they are the only copies.
 */
export async function migrateLegacyConfig(
  configDir: string,
  home: string,
  log: (line: string) => void = (line) => console.error(line),
): Promise<string | null> {
  if ((await readIfPresent(path.join(configDir, ".env"))) !== null) return null;
  for (const legacy of legacyConfigDirs(configDir, home)) {
    const text = await readIfPresent(path.join(legacy, ".env"));
    if (text === null) continue;
    const wasEmpty = await isMissingOrEmpty(configDir);
    await mkdir(configDir, { recursive: true });
    const { text: rewritten, renamed } = rewriteSighterKeys(text);
    try {
      // `wx`: never overwrite, even if a `.env` appeared since the check above.
      await writeFile(path.join(configDir, ".env"), rewritten, { flag: "wx" });
    } catch {
      return null;
    }
    if (wasEmpty) {
      for (const name of ["commands.toml", "keys.toml"]) {
        await copyFile(path.join(legacy, name), path.join(configDir, name), constants.COPYFILE_EXCL).catch(
          () => {},
        );
      }
    }
    log(
      `config: copied pre-1.0 Sighter env from ${legacy}` +
        (renamed.length ? ` (renamed ${renamed.join(", ")} to SIGHTR_*)` : ""),
    );
    const unknown = [...parseEnv(rewritten, ".env").values.keys()].filter(
      (key) => !key.startsWith("SIGHTR_") && !key.startsWith("HERDR_"),
    );
    if (unknown.length) log(`warn: config: kept ${unknown.join(", ")} as-is; check they still apply`);
    return legacy;
  }
  return null;
}
