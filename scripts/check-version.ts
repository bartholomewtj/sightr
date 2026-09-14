// Version consistency gate. herdr-plugin.toml is canonical; package.json, web/package.json and the
// newest "## [x.y.z]" CHANGELOG heading must match it. Run by `bun scripts/check-version.ts`,
// by `scripts/bump.ts` after a bump, by the ctl `build` verb, and by CI.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type VersionReport = { canonical: string; versions: Record<string, string>; ok: boolean };

function first(pattern: RegExp, text: string): string {
  return pattern.exec(text)?.[1] ?? "";
}

export function checkVersion(root: string): VersionReport {
  const read = (file: string): string => readFileSync(join(root, file), "utf8");
  const canonical = first(/^\s*version\s*=\s*"([^"]*)"/m, read("herdr-plugin.toml"));
  if (canonical === "") throw new Error("could not read version from herdr-plugin.toml");
  const versions: Record<string, string> = {
    "package.json": first(/"version"\s*:\s*"([^"]*)"/, read("package.json")),
    "web/package.json": first(/"version"\s*:\s*"([^"]*)"/, read("web/package.json")),
    "CHANGELOG.md": first(/^##\s*\[([0-9][^\]]*)\]/m, read("CHANGELOG.md")),
  };
  const ok = Object.values(versions).every((v) => v === canonical);
  return { canonical, versions, ok };
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  try {
    const report = checkVersion(root);
    if (!report.ok) {
      console.error("version mismatch; all must equal the canonical herdr-plugin.toml version:");
      console.error(`  herdr-plugin.toml  ${report.canonical}  (canonical)`);
      for (const [file, v] of Object.entries(report.versions)) console.error(`  ${file.padEnd(18)} ${v || "<missing>"}`);
      process.exit(1);
    }
    console.log(`version ${report.canonical} consistent across manifest, package.json, web/package.json, CHANGELOG`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
