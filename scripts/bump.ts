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

const SECTION_ORDER: Section[] = ["Added", "Changed", "Fixed"];

// Put the note first under `### <section>`, adding that heading in Added/Changed/Fixed order when the
// body lacks it.
function withNote(body: string, note: string, section: Section): string {
  const lines = body.length > 0 ? body.split("\n") : [];
  const own = lines.findIndex((line) => line.trim() === `### ${section}`);
  if (own !== -1) {
    let at = own + 1;
    while (at < lines.length && lines[at]?.trim() === "") at += 1;
    lines.splice(at, 0, `- ${note}`);
    return lines.join("\n");
  }
  const later = SECTION_ORDER.slice(SECTION_ORDER.indexOf(section) + 1);
  const before = lines.findIndex((line) => later.some((name) => line.trim() === `### ${name}`));
  const block = [`### ${section}`, `- ${note}`];
  if (before === -1) return [...lines, ...(lines.length > 0 ? [""] : []), ...block].join("\n");
  lines.splice(before, 0, ...block, "");
  return lines.join("\n");
}

// `body` is what sat under `## [Unreleased]`; it moves under the new heading so pending notes survive.
export function changelogEntry(
  version: string,
  date: Date,
  note?: string,
  section: Section = "Changed",
  body = "",
): string {
  const heading = `## [${version}] - ${dateString(date)}`;
  const pending = body.trim();
  if (note === undefined) {
    if (pending.length === 0) return `${heading}\n\n### Added\n\n### Changed\n\n### Fixed\n`;
    return `${heading}\n\n${pending}\n`;
  }
  return `${heading}\n\n${withNote(pending, note, section)}\n`;
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

  // Work in LF and write back in the file's own line ending (autocrlf checkouts are CRLF).
  const raw = readFileSync(changelogPath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const changelog = raw.replace(/\r\n/g, "\n");
  const write = (text: string): void => writeFileSync(changelogPath, text.replace(/\n/g, eol));
  const today = opts.today ?? new Date();
  const unreleased = /^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[\d|(?![\s\S]))/m.exec(changelog);
  if (unreleased) {
    const end = unreleased.index + unreleased[0].length;
    const entry = changelogEntry(to, today, opts.note, section, unreleased[1] ?? "");
    const gap = end < changelog.length ? "\n" : "";
    write(`${changelog.slice(0, unreleased.index)}## [Unreleased]\n\n${entry}${gap}${changelog.slice(end)}`);
  } else {
    const heading = /^## \[/m.exec(changelog);
    if (heading?.index === undefined) throw new Error("could not find a CHANGELOG heading");
    const entry = changelogEntry(to, today, opts.note, section);
    write(`${changelog.slice(0, heading.index)}## [Unreleased]\n\n${entry}\n${changelog.slice(heading.index)}`);
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
