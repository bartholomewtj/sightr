import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contractNames, defaultCacheDir, isInside, parseArgs, run, type Report } from "./t3-upstream.ts";

// A tiny local "T3" repo stands in for github.com/pingdotgg/t3code: no network in tests.
//   old (tag v0.0.1) -> first (ledger baseline) -> second (tag v0.2.0) -> third (main)
let root = "";
let fixture = "";
let old = "";
let first = "";
let second = "";
let third = "";

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

function commit(message: string): string {
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}

const UI = "apps/web/src/components/ui";
const CONTRACT = "packages/contracts/src/orchestrationV2.ts";

const contractV1 = `import * as Schema from "effect/Schema";

export const OrchestrationV2TurnItemType = Schema.Literals([
  "user_message",
  "assistant_message",
]);

export const OrchestrationV2Thread = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
  oldKey: Schema.optional(Schema.String),
});

export const OrchestrationV2UserInputQuestion = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
});
`;

const contractV2 = `import * as Schema from "effect/Schema";

export const OrchestrationV2TurnItemType = Schema.Literals([
  "user_message",
  "assistant_message",
]);

export const OrchestrationV2NewItem = Schema.Struct({ type: Schema.Literal("new_item"), at: Schema.Number });

export const OrchestrationV2Thread = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
});

export const OrchestrationV2UserInputQuestion = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
});
`;

function writeManifest(name: string, body: unknown): string {
  const path = join(root, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return path;
}

let manifest = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sightr-t3-upstream-"));
  fixture = join(root, "t3code");
  mkdirSync(fixture);
  git(["init", "--quiet", "--initial-branch=main"]);
  put(`${UI}/button.tsx`, "export const Button = 0;\n");
  old = commit("old");
  git(["tag", "v0.0.1"]);

  put(`${UI}/button.tsx`, "export const Button = 1;\n");
  put(`${UI}/badge.tsx`, "export const Badge = 1;\n");
  put(`${UI}/kbd.tsx`, "export const Kbd = 1;\n");
  put(CONTRACT, contractV1);
  first = commit("first");

  put(`${UI}/button.tsx`, "export const Button = 2;\n");
  unlinkSync(join(fixture, UI, "kbd.tsx"));
  put(`${UI}/toast.tsx`, "export const Toast = 1;\n");
  put(`${UI}/toast.test.tsx`, "test\n");
  put("apps/web/src/components/chat/MessagesTimeline.tsx", "export {};\n");
  put("apps/web/src/components/chat/deep/Nested.tsx", "export {};\n");
  put("apps/server/src/other.ts", "export {};\n");
  put(CONTRACT, contractV2);
  second = commit("second");
  git(["tag", "v0.2.0"]);

  put(`${UI}/button.tsx`, "export const Button = 3;\n");
  third = commit("third");

  manifest = writeManifest("manifest.json", {
    repo: "unused",
    baseline: first,
    folders: ["apps/web/src/components/", "apps/web/src/components/chat/", "apps/web/src/components/ui/"],
    files: [
      { local: "src/components/ui/button.tsx", upstream: `${UI}/button.tsx`, commit: first, mode: "verbatim" },
      { local: "src/components/ui/badge.tsx", upstream: `${UI}/badge.tsx`, commit: first, mode: "verbatim" },
      { local: "src/components/ui/kbd.tsx", upstream: `${UI}/kbd.tsx`, commit: first, mode: "verbatim" },
      { local: "../shared/v2/contracts.ts", upstream: CONTRACT, commit: first, mode: "shape" },
      { local: "../shared/v2/request-question.ts", upstream: CONTRACT, commit: first, mode: "shape", note: "OrchestrationV2UserInputQuestion" },
    ],
    decisions: [
      // Short sha, as the ledger writes them. Made at `second`; `third` changes the button again.
      { upstream: `${UI}/button.tsx`, commit: second.slice(0, 12), verdict: "skip", reason: "not wanted", date: "2026-10-18" },
      { upstream: `${UI}/toast.tsx`, commit: second, verdict: "defer", reason: "later" },
    ],
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function report(extra: string[] = [], manifestPath = manifest): { code: number; text: string; errors: string } {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = run(["--manifest", manifestPath, "--cache", join(root, "cache"), "--remote", fixture, ...extra], {
    log: (l) => lines.push(l),
    error: (l) => errors.push(l),
  });
  return { code, text: lines.join("\n"), errors: errors.join("\n") };
}

function json(extra: string[] = []): Report {
  const { code, text } = report(["--json", ...extra]);
  expect(code).toBe(0);
  return JSON.parse(text) as Report;
}

describe("t3-upstream", () => {
  test("compares against main by default and lists new files", () => {
    const { code, text } = report();
    expect(code).toBe(0);
    expect(text).toContain(`at main (${third.slice(0, 12)})`);
    expect(text).toMatch(/^changed\s+src\/components\/ui\/button\.tsx\s+<-\s+\S+ \(verbatim\)$/m);
    expect(text).toMatch(/^unchanged\s+src\/components\/ui\/badge\.tsx/m);
    expect(text).toMatch(/^removed\s+src\/components\/ui\/kbd\.tsx/m);
    expect(text).toContain(`  ${UI}/toast.tsx`);
    expect(text).toContain("  apps/web/src/components/chat/MessagesTimeline.tsx");
    expect(text).not.toContain("toast.test.tsx");
    expect(text).not.toContain("Nested.tsx");
    expect(text).not.toContain("apps/server");
    // No diff unless asked.
    expect(text).not.toContain("+export const Button = 3;");
  });

  test("a stale local main in the cache does not win over the remote's main", () => {
    // The cache's own `main` stays where the first clone left it; only origin/main moves on fetch.
    git(["update-ref", "refs/heads/main", first], join(root, "cache"));
    expect(json().ref.sha).toBe(third);
  });

  test("--diff prints the upstream diff of a changed row (and fetches an existing cache)", () => {
    const { text } = report(["--diff"]);
    expect(text).toContain("-export const Button = 1;");
    expect(text).toContain("+export const Button = 3;");
  });

  test("a shape row outside web2/ reports changed, with the added tag and the removed struct key", () => {
    const r = json();
    const row = r.rows.find((x) => x.local === "../shared/v2/contracts.ts");
    expect(row).toMatchObject({ mode: "shape", status: "changed" });
    const contract = r.contracts.find((c) => c.local === "../shared/v2/contracts.ts");
    expect(contract?.added).toContain('OrchestrationV2NewItem "new_item"');
    expect(contract?.added).toContain("OrchestrationV2NewItem.at");
    expect(contract?.removed).toEqual(["OrchestrationV2Thread.oldKey"]);
    // The question row only watches OrchestrationV2UserInputQuestion, which did not change.
    expect(r.contracts.find((c) => c.local === "../shared/v2/request-question.ts")).toEqual({
      local: "../shared/v2/request-question.ts",
      added: [],
      removed: [],
    });
    const { text } = report();
    expect(text).toMatch(/^changed\s+\.\.\/shared\/v2\/contracts\.ts\s+<-\s+packages\/contracts\/src\/orchestrationV2\.ts \(shape\)$/m);
    expect(text).toContain('    + OrchestrationV2NewItem "new_item"');
    expect(text).toContain("    - OrchestrationV2Thread.oldKey");
  });

  test("a local path that resolves outside the repo is refused", () => {
    const bad = writeManifest("outside.json", {
      repo: "unused",
      baseline: first,
      folders: [],
      files: [{ local: "../../../outside.ts", upstream: CONTRACT, commit: first, mode: "shape" }],
    });
    const { code, errors } = report([], bad);
    expect(code).toBe(1);
    expect(errors).toContain("resolves outside the repo");
  });

  test("--json parses, matches the documented shape and agrees with the text output", () => {
    const r = json();
    expect(Object.keys(r).sort()).toEqual(["baseline", "contracts", "newFiles", "ref", "rows"]);
    expect(r.ref).toEqual({ name: "main", sha: third });
    expect(r.baseline).toBe(first);
    for (const row of r.rows) expect(Object.keys(row)).toEqual(expect.arrayContaining(["local", "upstream", "mode", "commit", "status"]));
    expect(r.newFiles.map((f) => f.path)).toEqual(["apps/web/src/components/chat/MessagesTimeline.tsx", `${UI}/toast.tsx`]);
    const { text } = report();
    for (const row of r.rows) {
      const line = text.split("\n").find((l) => l.includes(` ${row.local}  <-  `));
      expect(line?.split(/\s+/)[0]).toBe(row.status);
    }
  });

  test("a decision hides a changed row at its commit; a later upstream change shows it again", () => {
    const at = json(["--ref", second]);
    const button = at.rows.find((x) => x.upstream === `${UI}/button.tsx`);
    expect(button?.status).toBe("changed");
    expect(button?.decided).toMatchObject({ verdict: "skip", reason: "not wanted" });
    expect(at.newFiles.find((f) => f.path === `${UI}/toast.tsx`)?.decided).toMatchObject({ verdict: "defer" });
    const { text } = report(["--ref", second]);
    expect(text).toMatch(/^changed\s+src\/components\/ui\/button\.tsx .*\(decided: skip — not wanted\)$/m);
    // Counts only undecided: button is decided; kbd removed and two shape rows changed are not.
    expect(text).toContain("1 unchanged, 2 changed, 1 removed (1 more changed or removed, decided)");

    const later = json();
    expect(later.rows.find((x) => x.upstream === `${UI}/button.tsx`)?.decided).toBeUndefined();
    // The new file did not change after its decision, so it stays decided.
    expect(later.newFiles.find((f) => f.path === `${UI}/toast.tsx`)?.decided).toBeDefined();
  });

  test("--ref pins the comparison; a clean report says there is nothing undecided", () => {
    const { code, text } = report(["--ref", first]);
    expect(code).toBe(0);
    expect(text).toContain("5 unchanged, 0 changed, 0 removed");
    expect(text).toContain("No new upstream files");
    expect(text).toContain("no undecided changes");
  });

  test("a ref behind the baseline exits 1 and names the problem", () => {
    const { code, text, errors } = report(["--ref", "v0.0.1"]);
    expect(code).toBe(1);
    expect(text).toBe("");
    expect(errors).toContain("not an ancestor");
    expect(errors).toContain(old.slice(0, 12));
  });

  test("an unknown ref exits 1", () => {
    const { code, errors } = report(["--ref", "no-such-ref"]);
    expect(code).toBe(1);
    expect(errors).toContain("no such ref no-such-ref");
  });

  test("a malformed ledger exits 1", () => {
    expect(report([], writeManifest("broken.json", "{ not json")).code).toBe(1);
    const badMode = writeManifest("bad-mode.json", {
      repo: "unused",
      baseline: first,
      folders: [],
      files: [{ local: "src/x.ts", upstream: "x.ts", commit: first, mode: "copied" }],
    });
    const r = report([], badMode);
    expect(r.code).toBe(1);
    expect(r.errors).toContain("mode");
    const badDecision = writeManifest("bad-decision.json", {
      repo: "unused",
      baseline: first,
      folders: [],
      files: [],
      decisions: [{ upstream: "x.ts", commit: first, verdict: "maybe", reason: "?" }],
    });
    expect(report([], badDecision).errors).toContain("verdict");
  });

  test("refuses a cache inside the repo", () => {
    const errors: string[] = [];
    const code = run(["--manifest", manifest, "--cache", join(import.meta.dir, "..", "tmp-cache")], {
      log: () => {},
      error: (l) => errors.push(l),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("inside the repo");
  });

  test("contractNames reads multi-line Literals lists, inline structs and a note filter", () => {
    const names = contractNames(contractV2);
    expect(names.has('OrchestrationV2TurnItemType "user_message"')).toBe(true);
    expect(names.has('OrchestrationV2TurnItemType "assistant_message"')).toBe(true);
    expect(names.has("OrchestrationV2NewItem.type")).toBe(true);
    expect(names.has("OrchestrationV2Thread.id")).toBe(true);
    expect([...contractNames(contractV2, "OrchestrationV2UserInputQuestion")].sort()).toEqual([
      "OrchestrationV2UserInputQuestion.id",
      "OrchestrationV2UserInputQuestion.question",
    ]);
  });

  test("parses arguments and picks a cache outside the repo", () => {
    const opts = parseArgs(["--ref", "v1", "--diff", "--json"], { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" });
    expect(opts).toMatchObject({ ref: "v1", diff: true, json: true, remote: null });
    expect(parseArgs([], {}).ref).toBeNull();
    expect(opts.cache).toBe(join("C:\\Users\\x\\AppData\\Local", "sightr", "t3-upstream"));
    expect(defaultCacheDir({ HOME: "/home/x" })).toBe(join("/home/x", ".cache", "sightr", "t3-upstream"));
    expect(isInside(join(import.meta.dir, "..", "web2"), join(import.meta.dir, ".."))).toBe(true);
    expect(isInside(root, join(import.meta.dir, ".."))).toBe(false);
    expect(() => parseArgs(["--bogus"], {})).toThrow("unknown argument");
  });
});
