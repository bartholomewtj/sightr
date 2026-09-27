import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "./env.ts";
import { legacyConfigDirs, migrateLegacyConfig, rewriteSighterKeys } from "./config-migrate.ts";

// Spec 11: a pre-1.0 `herdr.sighter/.env` is copied once, keys renamed, into an empty
// `herdr.sightr`. Temp dirs only; the operator's live config is never touched.

async function layout() {
  const root = await mkdtemp(path.join(tmpdir(), "sightr-cfg-"));
  const home = path.join(root, "home");
  const configDir = path.join(root, "herdr.sightr");
  const legacy = path.join(root, "herdr.sighter");
  await mkdir(legacy, { recursive: true });
  return { root, home, configDir, legacy };
}

const quiet = () => {};

describe("migrateLegacyConfig", () => {
  test("copies a sibling herdr.sighter .env into a missing config dir, renaming SIGHTER_ keys", async () => {
    const { home, configDir, legacy } = await layout();
    const old = "SIGHTER_TRUSTED_USER=you@example.com\r\n# a comment\r\nexport SIGHTER_PORT=8788\r\nHERDR_SOCKET_PATH=x\r\n";
    await writeFile(path.join(legacy, ".env"), old);
    await writeFile(path.join(legacy, "commands.toml"), "[[command]]\n");
    const lines: string[] = [];
    expect(await migrateLegacyConfig(configDir, home, (l) => lines.push(l))).toBe(legacy);
    const copied = await readFile(path.join(configDir, ".env"), "utf8");
    expect(copied).toBe(
      "SIGHTR_TRUSTED_USER=you@example.com\r\n# a comment\r\nexport SIGHTR_PORT=8788\r\nHERDR_SOCKET_PATH=x\r\n",
    );
    expect(await readFile(path.join(legacy, ".env"), "utf8")).toBe(old); // old file untouched
    expect(await readFile(path.join(configDir, "commands.toml"), "utf8")).toBe("[[command]]\n");
    expect(lines[0]).toContain(`config: copied pre-1.0 Sighter env from ${legacy}`);
    expect(lines[0]).toContain("SIGHTER_TRUSTED_USER");
  });

  test("never overwrites or merges into a config dir that already has a .env", async () => {
    const { home, configDir, legacy } = await layout();
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, ".env"), "SIGHTR_PORT=9000\n");
    await writeFile(path.join(legacy, ".env"), "SIGHTER_PORT=8788\n");
    expect(await migrateLegacyConfig(configDir, home, quiet)).toBeNull();
    expect(await readFile(path.join(configDir, ".env"), "utf8")).toBe("SIGHTR_PORT=9000\n");
  });

  test("copies only the .env into a config dir that already has other files", async () => {
    const { home, configDir, legacy } = await layout();
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "keys.toml"), "mine\n");
    await writeFile(path.join(legacy, ".env"), "SIGHTER_PORT=8788\n");
    await writeFile(path.join(legacy, "keys.toml"), "theirs\n");
    await writeFile(path.join(legacy, "commands.toml"), "theirs\n");
    expect(await migrateLegacyConfig(configDir, home, quiet)).toBe(legacy);
    expect(await readFile(path.join(configDir, "keys.toml"), "utf8")).toBe("mine\n");
    expect(await readFile(path.join(configDir, "commands.toml"), "utf8").catch(() => null)).toBeNull();
  });

  test("falls back to ~/.config/sighter, and does nothing when no legacy .env exists", async () => {
    const { home, configDir, root } = await layout();
    expect(await migrateLegacyConfig(configDir, home, quiet)).toBeNull();
    const dotConfig = path.join(home, ".config", "sighter");
    await mkdir(dotConfig, { recursive: true });
    await writeFile(path.join(dotConfig, ".env"), "SIGHTER_VAPID_PUBLIC=k\n");
    expect(await migrateLegacyConfig(configDir, home, quiet)).toBe(dotConfig);
    expect(await readFile(path.join(configDir, ".env"), "utf8")).toBe("SIGHTR_VAPID_PUBLIC=k\n");
    expect(root.length).toBeGreaterThan(0);
  });

  test("warns about keys it kept as-is", async () => {
    const { home, configDir, legacy } = await layout();
    await writeFile(path.join(legacy, ".env"), "SIGHTER_PORT=1\nCOLLIE_THING=2\n");
    const lines: string[] = [];
    await migrateLegacyConfig(configDir, home, (l) => lines.push(l));
    expect(lines.some((l) => l.includes("kept COLLIE_THING as-is"))).toBe(true);
  });
});

describe("helpers", () => {
  test("the sibling legacy dir comes from the config dir's own name", () => {
    const dirs = legacyConfigDirs(path.join("C:", "cfg", "herdr.sightr"), path.join("C:", "home"));
    expect(dirs).toEqual([path.join("C:", "cfg", "herdr.sighter"), path.join("C:", "home", ".config", "sighter")]);
  });

  test("rewrites the prefix only", () => {
    const { text, renamed } = rewriteSighterKeys("SIGHTER_A=SIGHTER_B\nNOT_SIGHTER_C=1\n");
    expect(text).toBe("SIGHTR_A=SIGHTER_B\nNOT_SIGHTER_C=1\n");
    expect(renamed).toEqual(["SIGHTER_A"]);
  });

  test("parseEnv does not alias SIGHTER_PORT to SIGHTR_PORT", () => {
    const { values } = parseEnv("SIGHTER_PORT=8788\n", ".env");
    expect(values.get("SIGHTR_PORT")).toBeUndefined();
    expect(values.get("SIGHTER_PORT")).toBe("8788");
  });
});
