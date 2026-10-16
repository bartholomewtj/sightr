import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultCacheDir, isInside, parseArgs, run } from "./t3-upstream.ts";

// A tiny local "T3" repo stands in for github.com/pingdotgg/t3code: no network in tests.
let root = "";
let fixture = "";
let first = "";
let second = "";

function git(args: string[], cwd = fixture): string {
  const proc = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

function put(path: string, body: string): void {
  const full = join(fixture, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

const UI = "apps/web/src/components/ui";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sightr-t3-upstream-"));
  fixture = join(root, "t3code");
  mkdirSync(fixture);
  git(["init", "--quiet", "--initial-branch=main"]);
  put(`${UI}/button.tsx`, "export const Button = 1;\n");
  put(`${UI}/badge.tsx`, "export const Badge = 1;\n");
  put(`${UI}/kbd.tsx`, "export const Kbd = 1;\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "one"]);
  first = git(["rev-parse", "HEAD"]);

  put(`${UI}/button.tsx`, "export const Button = 2;\n");
  unlinkSync(join(fixture, UI, "kbd.tsx"));
  put(`${UI}/toast.tsx`, "export const Toast = 1;\n");
  put(`${UI}/toast.test.tsx`, "test\n");
  put("apps/web/src/components/chat/MessagesTimeline.tsx", "export {};\n");
  put("apps/web/src/components/chat/deep/Nested.tsx", "export {};\n");
  put("apps/server/src/other.ts", "export {};\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "two"]);
  second = git(["rev-parse", "HEAD"]);
  git(["tag", "v0.2.0"]);

  const manifest = {
    repo: "unused",
    baseline: first,
    folders: ["apps/web/src/components/", "apps/web/src/components/chat/", "apps/web/src/components/ui/"],
    files: [
      { local: "src/components/ui/button.tsx", upstream: `${UI}/button.tsx`, commit: first, mode: "verbatim" },
      { local: "src/components/ui/badge.tsx", upstream: `${UI}/badge.tsx`, commit: first, mode: "verbatim" },
      { local: "src/components/ui/kbd.tsx", upstream: `${UI}/kbd.tsx`, commit: first, mode: "verbatim" },
    ],
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function report(extra: string[] = []): { code: number; text: string } {
  const lines: string[] = [];
  const code = run(
    ["--manifest", join(root, "manifest.json"), "--cache", join(root, "cache"), "--remote", fixture, ...extra],
    { log: (l) => lines.push(l) },
  );
  return { code, text: lines.join("\n") };
}

describe("t3-upstream", () => {
  test("reports each row against the latest tag and lists new files", () => {
    const { code, text } = report();
    expect(code).toBe(0);
    expect(text).toContain(`at v0.2.0 (${second.slice(0, 12)})`);
    expect(text).toMatch(/^changed\s+src\/components\/ui\/button\.tsx/m);
    expect(text).toMatch(/^unchanged\s+src\/components\/ui\/badge\.tsx/m);
    expect(text).toMatch(/^removed\s+src\/components\/ui\/kbd\.tsx/m);
    expect(text).toContain("1 unchanged, 1 changed, 1 removed");
    expect(text).toContain(`  ${UI}/toast.tsx`);
    expect(text).toContain("  apps/web/src/components/chat/MessagesTimeline.tsx");
    expect(text).not.toContain("toast.test.tsx");
    expect(text).not.toContain("Nested.tsx");
    expect(text).not.toContain("apps/server");
    // No diff unless asked.
    expect(text).not.toContain("+export const Button = 2;");
  });

  test("--diff prints the upstream diff of a changed row (and fetches an existing cache)", () => {
    const { text } = report(["--diff"]);
    expect(text).toContain("-export const Button = 1;");
    expect(text).toContain("+export const Button = 2;");
  });

  test("--ref pins the comparison", () => {
    const { text } = report(["--ref", first]);
    expect(text).toContain("3 unchanged, 0 changed, 0 removed");
    expect(text).toContain("No new upstream files");
  });

  test("an unknown ref is reported, still exit 0", () => {
    const { code, text } = report(["--ref", "no-such-ref"]);
    expect(code).toBe(0);
    expect(text).toContain("no such ref no-such-ref");
  });

  test("refuses a cache inside the repo", () => {
    const lines: string[] = [];
    const code = run(["--manifest", join(root, "manifest.json"), "--cache", join(import.meta.dir, "..", "tmp-cache")], {
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("inside the repo");
  });

  test("parses arguments and picks a cache outside the repo", () => {
    const opts = parseArgs(["--ref", "v1", "--diff"], { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" });
    expect(opts).toMatchObject({ ref: "v1", diff: true, remote: null });
    expect(opts.cache).toBe(join("C:\\Users\\x\\AppData\\Local", "sightr", "t3-upstream"));
    expect(defaultCacheDir({ HOME: "/home/x" })).toBe(join("/home/x", ".cache", "sightr", "t3-upstream"));
    expect(isInside(join(import.meta.dir, "..", "web2"), join(import.meta.dir, ".."))).toBe(true);
    expect(isInside(root, join(import.meta.dir, ".."))).toBe(false);
    expect(() => parseArgs(["--bogus"], {})).toThrow("unknown argument");
  });
});
