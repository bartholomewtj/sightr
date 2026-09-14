import { access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export async function resolveBun(env: Record<string, string | undefined> = process.env): Promise<string> {
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  const candidates = [process.execPath, ...(env.BUN_INSTALL ? [path.join(env.BUN_INSTALL, "bin", "bun.exe")] : []), path.join(home, ".bun/bin/bun.exe"), path.join(env.ProgramData ?? "", "chocolatey/bin/bun.exe"), path.join(env.LOCALAPPDATA ?? "", "bun/bin/bun.exe")];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { await access(candidate); return candidate; } catch { /* next */ }
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "bun.exe");
    try { await access(candidate); return candidate; } catch { /* next */ }
  }
  return "";
}
