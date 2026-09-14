import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bump, nextVersion, readCanonicalVersion } from "./bump.ts";
import { checkVersion } from "./check-version.ts";

// A version bump can silently leave one manifest or the newest changelog heading behind. These
// tests use disposable copies and run the same consistency gate that catches that drift in CI.

const repoRoot = join(import.meta.dir, "..");

function removeTree(root: string) {
  // Windows: Git Bash / AV can hold the temp dir after spawnSync. Node retries EBUSY.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "sightr-bump-"));
  mkdirSync(join(root, "web"));
  mkdirSync(join(root, "scripts"));
  cpSync(join(repoRoot, "herdr-plugin.toml"), join(root, "herdr-plugin.toml"));
  cpSync(join(repoRoot, "package.json"), join(root, "package.json"));
  cpSync(join(repoRoot, "CHANGELOG.md"), join(root, "CHANGELOG.md"));
  cpSync(join(repoRoot, "web", "package.json"), join(root, "web", "package.json"));
  return root;
}

function contents(root: string, file: string): string {
  return readFileSync(join(root, file), "utf8");
}

function manifestVersions(root: string): string[] {
  return ["herdr-plugin.toml", "package.json", "web/package.json"].map((file) => {
    const match = /(?:version\s*=\s*|"version":\s*")"?([^"\n]+)"?/.exec(contents(root, file));
    return match?.[1] ?? "";
  });
}

describe("bump", () => {
  test("patch produces a tree that passes the version gate", () => {
    const root = makeTree();
    try {
      const from = readCanonicalVersion(root);
      const result = bump({ root, kind: "patch", today: new Date(2026, 8, 1) });
      expect(result.to).toBe(nextVersion(from, "patch"));
      expect(manifestVersions(root)).toEqual([result.to, result.to, result.to]);
      expect(checkVersion(root).ok).toBe(true);
    } finally {
      removeTree(root);
    }
  });

  test("minor increments the minor component and resets patch", () => {
    const root = makeTree();
    try {
      const from = readCanonicalVersion(root);
      const expected = nextVersion(from, "minor");
      bump({ root, kind: "minor", today: new Date(2026, 8, 1) });
      expect(manifestVersions(root)).toEqual([expected, expected, expected]);
      expect(contents(root, "CHANGELOG.md")).toContain(`## [${expected}] - 2026-09-01`);
    } finally {
      removeTree(root);
    }
  });

  test("major increments the major component and resets the rest", () => {
    const root = makeTree();
    try {
      const starting = readCanonicalVersion(root);
      const expected = nextVersion(starting, "major");
      bump({ root, kind: "major", today: new Date(2026, 8, 1) });
      expect(manifestVersions(root)).toEqual([expected, expected, expected]);
    } finally {
      removeTree(root);
    }
  });

  test("inserts a note in the requested section without changing the old heading", () => {
    const root = makeTree();
    try {
      const from = readCanonicalVersion(root);
      const expected = nextVersion(from, "patch");
      bump({ root, kind: "patch", note: "did a thing (#254)", section: "Added", today: new Date(2026, 8, 1) });
      const changelog = contents(root, "CHANGELOG.md");
      expect(changelog.indexOf(`## [${expected}]`)).toBeLessThan(changelog.indexOf(`## [${from}]`));
      expect(changelog).toContain(`### Added\n- did a thing (#254)\n\n## [${from}]`);
    } finally {
      removeTree(root);
    }
  });

  test("refuses when a version file is staged before writing anything", () => {
    const root = makeTree();
    try {
      Bun.spawnSync(["git", "-C", root, "init", "-q"]);
      Bun.spawnSync(["git", "-C", root, "add", "package.json"]);
      const packageBefore = contents(root, "package.json");
      const changelogBefore = contents(root, "CHANGELOG.md");
      expect(() => bump({ root, kind: "patch" })).toThrow(/unstage them or finish the manual bump first/);
      expect(contents(root, "package.json")).toBe(packageBefore);
      expect(contents(root, "CHANGELOG.md")).toBe(changelogBefore);
    } finally {
      removeTree(root);
    }
  });

  test("formats injected dates with a local-time two-digit month and day", () => {
    const root = makeTree();
    try {
      const expected = nextVersion(readCanonicalVersion(root), "patch");
      bump({ root, kind: "patch", today: new Date(2026, 0, 5) });
      expect(contents(root, "CHANGELOG.md")).toContain(`## [${expected}] - 2026-01-05`);
    } finally {
      removeTree(root);
    }
  });
});

describe("nextVersion", () => {
  test("rejects versions that are not numeric x.y.z", () => {
    expect(() => nextVersion("0.89", "patch")).toThrow(/expected x\.y\.z/);
  });
});
