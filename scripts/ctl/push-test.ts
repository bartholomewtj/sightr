import path from "node:path";
import { effectiveEnv } from "./env.ts";
import { resolveBun } from "./bun.ts";
import { CtlError, realRun, type Run } from "./types.ts";
export async function pushTest(args:string[],env=process.env,run:Run=realRun,findBun:(env:Record<string,string|undefined>)=>Promise<string>=resolveBun){const {paths,effective}=await effectiveEnv(env,run);const bun=await findBun(effective);if(!bun)throw new CtlError("error: bun not found on PATH",1);return (await run(bun,["run",path.join(paths.pluginRoot,"scripts/push-test.ts"),...args],{env:{...effective,PATH:`${path.dirname(bun)}${path.delimiter}${effective.PATH??""}`} as Record<string,string>,stdio:"inherit"})).code;}
