import { access } from "node:fs/promises";
import { resolvePaths } from "./paths.ts";
import { loadEnv } from "./env.ts";
import { hardenConfig } from "./perms.ts";
import { realRun, type Run, CtlError } from "./types.ts";
export async function envCheck(env: Record<string,string|undefined>=process.env, run:Run=realRun): Promise<number> {
 const p=await resolvePaths(env,run); try { await access(p.configDir); } catch { throw new CtlError(`error: cannot read config directory ${p.configDir}`,1); }
 const warnings=await hardenConfig(p.configDir,p.envFile,run,env); warnings.forEach(x=>console.error(x));
 let exists=false; try { await access(p.envFile); exists=true; } catch { }
 console.log(`config dir: ${p.configDir}\n.env: ${p.envFile}\nexists: ${exists ? "yes":"no"}\npermission/ACL: ACL checked`);
 if(exists) { const parsed=await loadEnv(p.envFile); parsed.warnings.forEach(x=>console.error(x)); console.log(`keys: ${[...parsed.values.keys()].join(", ")}`); } else console.log("keys: (none)"); return 0;
}
