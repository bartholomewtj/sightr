import path from "node:path";
import { realRun, type Run } from "./types.ts";
import { pluginRoot } from "./paths.ts";
import { resolveBun } from "./bun.ts";
import { build } from "./build.ts";
import { restart } from "./lifecycle.ts";

export type TagRef = { major:number; minor:number; patch:number; tag:string; commit:string };
const tagRe = /^v(\d+)\.(\d+)\.(\d+)$/;
export function parseLsRemoteTags(stdout:string): TagRef[] {
  const map = new Map<string, TagRef>();
  for (const line of stdout.split(/\r?\n/)) { const [commit, ref] = line.trim().split(/\s+/); if (!commit || !ref || !ref.startsWith("refs/tags/")) continue; let tag=ref.slice(10), peeled=false; if (tag.endsWith("^{}")) { tag=tag.slice(0,-3); peeled=true; } const m=tagRe.exec(tag); if (!m) continue; if (!map.has(tag) || peeled) map.set(tag,{major:+m[1]!,minor:+m[2]!,patch:+m[3]!,tag,commit}); }
  return [...map.values()].sort((a,b)=>a.major-b.major||a.minor-b.minor||a.patch-b.patch);
}
export function releaseInMajor(tags:TagRef[], major:number) { return tags.filter(t=>t.major===major).sort((a,b)=>a.minor-b.minor||a.patch-b.patch).at(-1); }
export function nextMajorRelease(tags:TagRef[], major:number) { const majors=tags.filter(t=>t.major>major).map(t=>t.major); if (!majors.length) return undefined; const next=Math.min(...majors); return releaseInMajor(tags,next); }
export function majorOf(version:string):number|undefined { const m=/^(\d+)\./.exec(version); return m ? +m[1]! : undefined; }
function parts(v:string) { const m=/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/.exec(v); return m ? [+m[1]!,+m[2]!,+m[3]!,m[4]] as const : undefined; }
export function versionGt(a:string,b:string) { const x=parts(a),y=parts(b); if(!x||!y)return false; for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]!>y[i]!; return !x[3] && !!y[3]; }
export function manifestVersionFrom(toml:string) { return toml.match(/^version\s*=\s*["']([^"']+)/m)?.[1] ?? ""; }

const git=(root:string,args:string[])=>["-C",root,...args];
async function detach(root:string,target:string,run:Run):Promise<number>{
 console.log(`updating Sightr (Herdr-managed checkout: fetch + detach onto ${target})…`);
 const shallow=await run("git",git(root,["rev-parse","--is-shallow-repository"]));
 const fetched=await run("git",git(root,["fetch",...(shallow.stdout.trim()==="true"?["--depth","1"]:[]),"origin","tag",target])); if(fetched.code!==0)return fetched.code;
 const checked=await run("git",git(root,["checkout","-q","--detach","--force",`refs/tags/${target}`])); if(checked.code!==0)return checked.code;
 const landed=(await run("git",git(root,["describe","--tags","--exact-match"]))).stdout.trim(); if(landed!==target){console.error(`error: checkout landed at '${landed||"unknown"}', expected tag '${target}'`);return 1;}
 const log=(await run("git",git(root,["log","-1","--format=%h %s"]))).stdout.trim(); console.log(`→ now at ${target} (${log})`); return 0;
}
async function pin(root:string,target:string,run:Run){ if(!target){console.error("error: no vX.Y.Z release tag found on origin; refuse to update to unverified origin HEAD\n       (override with SIGHTR_UPDATE_REF=<tag-or-ref> if you intended a specific ref)");return 1;} return detach(root,target,run); }
function announce(t?:TagRef){if(t){console.log(`note: Sightr ${t.major}.${t.minor}.${t.patch} is out — a NEW MAJOR, which a routine update never takes.`);console.log("      Read its release notes, then consent to it with:  herdr plugin action invoke update-major --plugin herdr.sightr");}}
export async function updateCheckout(args:string[],opts:{root?:string;env?:Record<string,string|undefined>;run?:Run}={}) :Promise<number>{
 const root=opts.root??pluginRoot, env=opts.env??process.env, run=opts.run??realRun, cross=args.includes("--major");
 if((await run("git",git(root,["rev-parse","--git-dir"]))).code!==0){console.error(`error: ${root} is not a git checkout — refresh it with:\n       herdr plugin install bartholomewtj/sightr --yes`);return 1;}
 const installed=manifestVersionFrom(await Bun.file(path.join(root,"herdr-plugin.toml")).text().catch(()=>""));
 const linked=(await run("git",git(root,["symbolic-ref","-q","HEAD"]))).code===0;
 if (linked) {
   const fetchedOrigin = await run("git", git(root, ["fetch", "origin"]));
   if (fetchedOrigin.code !== 0) return fetchedOrigin.code;
   const ref = (await run("git", git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]))).stdout.trim();
   if (ref) {
     const fetched = manifestVersionFrom((await run("git", git(root, ["show", `${ref}:herdr-plugin.toml`]))).stdout);
     const installedMajor = majorOf(installed), fetchedMajor = majorOf(fetched);
     if (!cross && installedMajor !== undefined && fetchedMajor !== undefined && fetchedMajor > installedMajor) {
       console.log(`refusing to update: ${installed} → ${fetched} (${ref}) crosses a MAJOR version.`);
       console.log("A major means you have to change something — so it is never taken by a routine update.");
       console.log("Read its release notes, then consent to it with:  herdr plugin action invoke update-major --plugin herdr.sightr");
       console.log("(nothing was pulled — this checkout is unchanged)"); return 0;
     }
   }
   console.log("updating Sightr (git pull --ff-only)…");
   return (await run("git", git(root, ["pull", "--ff-only"]))).code;
 }
 if(env.SIGHTR_UPDATE_REF)return pin(root,env.SIGHTR_UPDATE_REF,run);
 const listed=await run("git",git(root,["ls-remote","--tags","origin"]));if(listed.code!==0){console.error("error: could not list the upstream release tags — is the remote reachable?");return 1;}
 const installedMajor=majorOf(installed); if(installedMajor===undefined){console.log("updating Sightr (Herdr-managed checkout: no readable version — pinning to newest release tag)…"); const sorted=await run("git",git(root,["ls-remote","--tags","--refs","--sort=-v:refname","origin","v*"])); const tags=parseLsRemoteTags(sorted.code===0?sorted.stdout:(await run("git",git(root,["ls-remote","--tags","--refs","origin","v*"]))).stdout); return pin(root,tags.at(-1)?.tag??"",run); }
 const tags=parseLsRemoteTags(listed.stdout); if (!tags.length) { console.error("error: no vX.Y.Z release tag found on origin; refuse to update to unverified origin HEAD\n       (override with SIGHTR_UPDATE_REF=<tag-or-ref> if you intended a specific ref)"); return 1; } const higher=nextMajorRelease(tags,installedMajor); if(cross){if(!higher){console.log(`no release above major ${installedMajor} exists yet — nothing to cross to.`);return 0;}console.log(`crossing to Sightr ${higher.major}.${higher.minor}.${higher.patch} (--major given: consented)…`);return detach(root,higher.tag,run);}
 const best=releaseInMajor(tags,installedMajor);if(!best){console.log(`no release of major ${installedMajor} yet — leaving this checkout where it is.`);announce(higher);return 0;}const head=(await run("git",git(root,["rev-parse","HEAD"]))).stdout.trim();if(best.commit===head||!versionGt(`${best.major}.${best.minor}.${best.patch}`,installed)){console.log(`already current — v${best.major}.${best.minor}.${best.patch} is the newest release of major ${installedMajor}.`);announce(higher);return 0;}const n=await detach(root,best.tag,run);if(n===0)announce(higher);return n;
}
export async function refreshRegistry(opts:{root?:string;run?:Run}={}){const root=opts.root??pluginRoot,run=opts.run??realRun;const probe=await run("herdr",["--version"]);if(probe.code===127)return;const linked=(await run("git",git(root,["symbolic-ref","-q","HEAD"]))).code===0;if(!linked){console.log("note: Herdr-managed install — registry left alone (re-linking would block `herdr plugin install`)");return;}const r=await run("herdr",["plugin","link",root]);if(r.code===0)console.log("herdr registry refreshed (re-linked) — new actions are invokable now");else console.log(`note: couldn't refresh the Herdr registry (is the Herdr server running?) —\n      run: herdr plugin link \"${root}\"`);}
export async function applyUpdate(env=process.env,run:Run=realRun,deps:{build?:(e:any,r:Run)=>Promise<number>;restart?:(e:any,r:Run)=>Promise<number>;refresh?:()=>Promise<void>}={}){const b=await (deps.build??build)(env,run);if(b!==0)return b;const rr=await (deps.restart??restart)(env,run);if(rr!==0)return rr;await (deps.refresh??(()=>refreshRegistry({run})))();console.log("✓ update complete");return 0;}
export async function update(args:string[],env=process.env,run:Run=realRun){const root=pluginRoot,n=await updateCheckout(args,{root,env,run});if(n!==0)return n;const bun=await resolveBun(env);if(!bun)return 1;return (await run(bun,[path.join(root,"scripts/ctl.ts"),"_apply-update"],{cwd:root,stdio:"inherit"})).code;}
