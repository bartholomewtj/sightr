import { readFile } from "node:fs/promises";
import { resolvePaths, type Paths } from "./paths.ts";
import { realRun, type Run } from "./types.ts";

export function parseEnv(text: string, fileLabel: string): { values: Map<string, string>; warnings: string[] } {
  const values = new Map<string, string>(); const warnings: string[] = [];
  text.split("\n").forEach((raw, index) => {
    let line = raw.endsWith("\r") ? raw.slice(0, -1) : raw; line = line.trim();
    if (!line || line.startsWith("#")) return;
    if (/^export\s/.test(line)) line = line.replace(/^export\s+/, "");
    const equals = line.indexOf("=");
    if (equals < 0) { warnings.push(`${fileLabel}:${index + 1}: malformed line; skipping`); return; }
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { warnings.push(`${fileLabel}:${index + 1}: invalid variable name; skipping`); return; }
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.set(key, value);
  }); return { values, warnings };
}
export async function loadEnv(path: string) { return parseEnv(await readFile(path, "utf8"), path); }

export async function effectiveEnv(env: Record<string, string | undefined> = process.env, run: Run = realRun): Promise<{ paths: Paths; effective: Record<string, string | undefined> }> {
  const paths = await resolvePaths(env, run); let parsed: { values: Map<string,string>; warnings: string[] } = { values: new Map(), warnings: [] };
  try { parsed = await loadEnv(paths.envFile); } catch (error: any) { if (error?.code !== "ENOENT") console.error(`warn: could not read ${paths.envFile}: ${error}`); }
  for (const warning of parsed.warnings) console.error(`warn: ${warning}`);
  return { paths, effective: { ...env, ...Object.fromEntries(parsed.values) } };
}
