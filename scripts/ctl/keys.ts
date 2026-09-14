import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveBun } from "./bun.ts";
import { resolvePaths } from "./paths.ts";
import { realRun, CtlError, type Run } from "./types.ts";
export async function keys(args: string[] = [], env: Record<string,string|undefined> = process.env, run: Run = realRun): Promise<number> {
 const bun=await resolveBun(env); if(!bun) throw new CtlError("error: bun not found on PATH",1); const p=await resolvePaths(env,run); await mkdir(p.configDir,{recursive:true});
 const r=await run(bun,["run",path.join(p.pluginRoot,"scripts/push-keys.ts"),p.envFile,...args],{stdio:"inherit",env:env as Record<string,string>}); return r.code;
}
