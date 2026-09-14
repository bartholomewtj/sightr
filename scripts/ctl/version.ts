import { readFile } from "node:fs/promises";
import type { Paths } from "./paths.ts";
export async function getVersion(paths: Pick<Paths, "buildInfo"|"pluginRoot">): Promise<string> {
  try { const info = JSON.parse(await readFile(paths.buildInfo, "utf8")) as { version?: string; sha?: string }; if (info.version) return info.sha ? `${info.version}+${info.sha}` : info.version; } catch { /* fallback */ }
  try { const manifest = await readFile(`${paths.pluginRoot}/herdr-plugin.toml`, "utf8"); const match = manifest.match(/^version\s*=\s*["']([^"']+)/m); if (match?.[1]) return `${match[1]} (manifest; web not built)`; } catch { /* fallback */ }
  return "unknown";
}
