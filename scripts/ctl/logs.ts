import { readFile } from "node:fs/promises";
import { effectiveEnv } from "./env.ts";
import { realRun, type Run } from "./types.ts";
function tail(text:string,n:number){const lines=text.replace(/\r?\n$/," ").trimEnd().split(/\r?\n/); return lines.slice(Math.max(0,lines.length-n)).join("\n");}
async function show(file:string,n:number,missing="(no log)"){try{console.log(tail(await readFile(file,"utf8"),n));}catch{console.log(missing);}}
// The bridge's stdout/stderr land in sightr.log / sightr-error.log; exec-bridge rotates the pair to *-previous.log on a crash.
export async function logs(args:string[],env=process.env,run:Run=realRun){const n=Number.parseInt(args[0]??"50",10)||50;const {paths}=await effectiveEnv(env,run);for(const [label,file] of [["previous bridge crash (stdout):","sightr-previous.log"],["previous bridge crash (stderr):","sightr-error-previous.log"]] as const){try{await readFile(`${paths.configDir}/${file}`,"utf8");console.log(label);await show(`${paths.configDir}/${file}`,n,"");}catch{}}await show(`${paths.configDir}/sightr.log`,n);await show(`${paths.configDir}/sightr-error.log`,n,"");return 0;}
