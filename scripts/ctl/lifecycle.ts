import { access } from "node:fs/promises";
import { resolvePaths } from "./paths.ts";
import { loadEnv } from "./env.ts";
import { resolveBun } from "./bun.ts";
import { CtlError, realRun, type Run } from "./types.ts";
import { selectSupervisor } from "./supervisor/index.ts";
import { selfHosts } from "./tailscale.ts";
import { serve, unserve } from "./serve.ts";
import { status } from "./status.ts";
import { build } from "./build.ts";
import { hardenConfig } from "./perms.ts";
async function setup(env:Record<string,string|undefined>,run:Run){const paths=await resolvePaths(env,run);for(const warning of await hardenConfig(paths.configDir,paths.envFile,run,env)) console.error(warning);let parsed=new Map<string,string>();try{parsed=(await loadEnv(paths.envFile)).values}catch{}const effective={...env,...Object.fromEntries(parsed)};const bun=await resolveBun(effective);if(!bun)throw new CtlError("error: bun not found on PATH");return {paths,effective,bun}}
/** A Task Scheduler launch can take 10-30 s before the bridge listens, so start waits longer than status does. */
export const START_WAIT_MS = 45_000;
export async function start(env=process.env,run:Run=realRun,opts:{waitMs?:number}={}){const x=await setup(env,run);try{await access(x.paths.webDist+"/index.html")}catch{console.log("building web UI (first run)…");try{await build(x.effective,run)}catch{console.error("warn: web build failed; API will run but the UI will 503 until built")}}const hosts=x.effective.SIGHTR_SKIP_SERVE==="1"?"":await selfHosts(run);const spec={paths:x.paths,env:x.effective,bun:x.bun,port:x.effective.SIGHTR_PORT??"8787",socket:x.effective.HERDR_SOCKET_PATH??x.effective.HERDR_SOCKET??"",hosts};const sup=selectSupervisor(x.effective);await sup.install(spec,run);await sup.enableNow(spec,run);try{const n=await serve(x.effective,run);if(n!==0)console.error(`note: the tailnet front door did not come up; the bridge is still on 127.0.0.1:${spec.port}`)}catch(e){if(e instanceof CtlError)console.error(e.message);console.error(`note: the tailnet front door did not come up; the bridge is still on 127.0.0.1:${spec.port}`)}await status(x.effective,run,{waitMs:opts.waitMs??START_WAIT_MS});return 0}
export async function stop(env=process.env,run:Run=realRun){const x=await setup(env,run),sup=selectSupervisor(x.effective),spec={paths:x.paths,env:x.effective,bun:x.bun,port:x.effective.SIGHTR_PORT??"8787",socket:x.effective.HERDR_SOCKET_PATH??"",hosts:""};await sup.disableNow(spec,run);console.log("bridge stopped");return 0}
export async function restart(env=process.env,run:Run=realRun){await stop(env,run);return start(env,run)}
export async function uninstall(env=process.env,run:Run=realRun){const x=await setup(env,run),sup=selectSupervisor(x.effective),spec={paths:x.paths,env:x.effective,bun:x.bun,port:x.effective.SIGHTR_PORT??"8787",socket:x.effective.HERDR_SOCKET_PATH??"",hosts:""};await sup.disableNow(spec,run);await unserve(x.effective,run);await sup.remove(spec,run);console.log("✓ uninstalled: scheduled task stopped & disabled, task definition removed, Sightr's tailscale serve mapping removed");console.log(`  kept: ${x.paths.configDir}/.env and the checkout — delete those to remove every trace`);return 0}
