import path from "node:path";
import os from "node:os";
import { realRun, type Run } from "./types.ts";

export interface Paths { pluginRoot: string; configDir: string; envFile: string; webDist: string; buildInfo: string; }
export const pluginRoot = path.resolve(import.meta.dir, "../..");

export async function resolvePaths(env: Record<string, string | undefined> = process.env, run: Run = realRun): Promise<Paths> {
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  let config = env.HERDR_PLUGIN_CONFIG_DIR?.trim();
  if (!config) {
    const result = await run("herdr", ["plugin", "config-dir", "herdr.sightr"]);
    config = result.code === 0 ? result.stdout.split(/\r?\n/)[0]?.trim() : "";
  }
  // Herdr's conventional Windows location; used when Herdr is not running to answer (e.g. at logon).
  if (!config) config = path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "herdr/plugins/config/herdr.sightr");
  return { pluginRoot, configDir: config, envFile: path.join(config, ".env"), webDist: path.join(pluginRoot, "web/dist"), buildInfo: path.join(pluginRoot, "web/dist/build-info.json") };
}
