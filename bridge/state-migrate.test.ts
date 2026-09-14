import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyStateDir, migrateLegacyState } from "./state-migrate";

describe("legacyStateDir", () => {
  it("maps the new name onto the old one, keeping case", () => {
    expect(legacyStateDir(join("x", "herdr.sightr"))).toBe(join("x", "herdr.sighter"));
    expect(legacyStateDir(join("x", "Sightr"))).toBe(join("x", "Sighter"));
    expect(legacyStateDir(join("x", "SIGHTR"))).toBe(join("x", "SIGHTER"));
  });
  it("leaves an operator-named directory alone", () => {
    expect(legacyStateDir(join("x", "bridge-state"))).toBeNull();
  });
});

describe("migrateLegacyState", () => {
  it("copies the old directory into an absent new one, once", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-migrate-"));
    const legacy = join(root, "herdr.sighter");
    await mkdir(join(legacy, "beacons"), { recursive: true });
    await writeFile(join(legacy, "lock.json"), "{}");
    await writeFile(join(legacy, "beacons", "w1~p1.json"), "{}");
    const fresh = join(root, "herdr.sightr");
    expect(await migrateLegacyState(fresh)).toBe(legacy);
    expect(await readFile(join(fresh, "lock.json"), "utf8")).toBe("{}");
    expect(await readdir(join(fresh, "beacons"))).toEqual(["w1~p1.json"]);
    // Second run: the new dir has state, so nothing happens.
    await writeFile(join(legacy, "lock.json"), "changed");
    expect(await migrateLegacyState(fresh)).toBeNull();
    expect(await readFile(join(fresh, "lock.json"), "utf8")).toBe("{}");
  });
  it("does nothing when there is no old directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-migrate-"));
    expect(await migrateLegacyState(join(root, "herdr.sightr"))).toBeNull();
  });
});
