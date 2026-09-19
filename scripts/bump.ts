import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkVersion } from "./check-version.ts";

export type Kind = "patch" | "minor" | "major";
export type Section = "Added" | "Changed" | "Fixed";

const VERSION = /^version\s*=\s*"([^"]+)"/m;
const PACKAGE_VERSION = /^(\s*)"version":\s*"[^"]*"/m;
const VERSION_KINDS = new Set<Kind>(["patch", "minor", "major"]);
const SECTIONS = new Set<Section>(["Added", "Changed", "Fixed"]);

export function nextVersion(current: string, kind: Kind): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) {
    throw new Error(`invalid version "${current}"; expected x.y.z`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

export function readCanonicalVersion(root: string): string {
  const match = VERSION.exec(readFileSync(join(root, "herdr-plugin.toml"), "utf8"));
  const version = match?.[1];
  if (version === undefined) throw new Error("could not read canonical version from herdr-plugin.toml");
  return version;
}

function dateString(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function changelogEntry(version: string, date: Date, note?: string, section: Section = "Changed"): string {
  const heading = `## [${version}] - ${dateString(date)}`;
  if (note === undefined) {
    return `${heading}\n\n### Added\n\n### Changed\n\n### Fixed\n`;
  }
  return `${heading}\n\n### ${section}\n- ${note}\n`;
}

export function stagedVersionFiles(root: string): string[] {
  const result = Bun.spawnSync([
    "git",
    "-C",
    root,
    "diff",
    "--cached",
    "--name-only",
    "--",
    "herdr-plugin.toml",
    "package.json",
    "web/package.json",
    "CHANGELOG.md",
  ]);
  if (result.exitCode !== 0) return [];
  return new TextDecoder().decode(result.stdout).split(/\r?\n/).filter((line) => line.length > 0);
}

export function bump(opts: {
  root: string;
  kind: Kind;
  note?: string;
  section?: Section;
  today?: Date;
}): { from: string; to: string } {
  const staged = stagedVersionFiles(opts.root);
  if (staged.length > 0) {
    throw new Error(`version files are staged (${staged.join(", ")}); unstage them or finish the manual bump first`);
  }

  const from = readCanonicalVersion(opts.root);
  const to = nextVersion(from, opts.kind);
  const section = opts.section ?? "Changed";
  const tomlPath = join(opts.root, "herdr-plugin.toml");
  const packagePath = join(opts.root, "package.json");
  const webPackagePath = join(opts.root, "web", "package.json");
  const changelogPath = join(opts.root, "CHANGELOG.md");

  const toml = readFileSync(tomlPath, "utf8");
  writeFileSync(tomlPath, toml.replace(VERSION, `version = "${to}"`));
  for (const path of [packagePath, webPackagePath]) {
    const contents = readFileSync(path, "utf8");
    writeFileSync(path, contents.replace(PACKAGE_VERSION, `$1"version": "${to}"`));
  }

  const changelog = readFileSync(changelogPath, "utf8");
  const entry = changelogEntry(to, opts.today ?? new Date(), opts.note, section);
  const unreleasedMatch = /^## \[Unreleased\][\s\S]*?(?=^## \[\d)/m.exec(changelog);
  if (unreleasedMatch) {
    writeFileSync(changelogPath, changelog.replace(unreleasedMatch[0], `${entry}\n`));
  } else {
    const heading = /^## \[/m.exec(changelog);
    if (heading?.index === undefined) throw new Error("could not find a CHANGELOG heading");
    writeFileSync(changelogPath, `${changelog.slice(0, heading.index)}${entry}\n${changelog.slice(heading.index)}`);
  }
  return { from, to };
}

function usage(): void {
  console.error('Usage: bun scripts/bump.ts patch|minor|major [--note "text"] [--section Added|Changed|Fixed]');
}

function parseArgs(args: string[]): { kind: Kind; note?: string; section?: Section } | undefined {
  const kindArg = args[0];
  if (kindArg === undefined || !VERSION_KINDS.has(kindArg as Kind)) return undefined;
  let note: string | undefined;
  let section: Section | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--note" && index + 1 < args.length) {
      note = args[index + 1];
      index += 1;
    } else if (flag === "--section" && index + 1 < args.length && SECTIONS.has(args[index + 1] as Section)) {
      section = args[index + 1] as Section;
      index += 1;
    } else {
      return undefined;
    }
  }
  return { kind: kindArg as Kind, ...(note === undefined ? {} : { note }), ...(section === undefined ? {} : { section }) };
}

if (import.meta.main) {
  const options = parseArgs(Bun.argv.slice(2));
  if (options === undefined) {
    usage();
    process.exit(2);
  }
  try {
    const root = join(import.meta.dir, "..");
    const result = bump({ root, ...options });
    const gate = checkVersion(root);
    if (!gate.ok) {
      console.error(`version gate failed after bump: ${JSON.stringify(gate.versions)} vs ${gate.canonical}`);
      process.exit(1);
    }
    console.log(`${result.from} → ${result.to}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
