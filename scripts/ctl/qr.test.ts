import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { qr } from "./qr.ts";
import type { Run } from "./types.ts";

function harness(status:any = {DNSName:"host.example."}, packet:any = [{rule:1}]) { const calls:any[]=[]; const run:Run=async(cmd,args,opts)=>{calls.push({cmd,args,opts}); if(cmd==="tailscale"&&args[0]==="status")return {code:0,stdout:JSON.stringify({Self:status}),stderr:""}; if(cmd==="tailscale")return {code:0,stdout:JSON.stringify({PacketFilter:packet}),stderr:""}; return {code:0,stdout:"",stderr:""};}; return {run,calls}; }
const bun=async()=>"C:/bun/bun.exe";

test("tailnet QR forwards the resolved URL",async()=>{const x=harness();await qr({HERDR_PLUGIN_CONFIG_DIR:".tmp-qr-a"},x.run,bun);expect(x.calls.at(-1).args).toEqual(["run",path.join(path.resolve(import.meta.dir,".."),"qr.ts"),"https://host.example"]);});
test("skip-serve QR uses the public URL",async()=>{const x=harness();await qr({HERDR_PLUGIN_CONFIG_DIR:".tmp-qr-b",SIGHTR_SKIP_SERVE:"1",SIGHTR_PUBLIC_URL:"https://public.example"},x.run,bun);expect(x.calls.at(-1).args.at(-1)).toBe("https://public.example");});
test("skip-serve without a public URL refuses to spawn",async()=>{const x=harness();expect(await qr({HERDR_PLUGIN_CONFIG_DIR:".tmp-qr-c",SIGHTR_SKIP_SERVE:"1"},x.run,bun)).toBe(1);expect(x.calls.some(c=>c.args?.[0]==="run")).toBe(false);});
test("a nameless tailnet refuses to create a dead QR",async()=>{const x=harness({});expect(await qr({HERDR_PLUGIN_CONFIG_DIR:".tmp-qr-d"},x.run,bun)).toBe(1);expect(x.calls.some(c=>c.args?.[0]==="run")).toBe(false);});
test("an empty packet filter warns but still draws",async()=>{const x=harness({DNSName:"host.example."},[]);expect(await qr({HERDR_PLUGIN_CONFIG_DIR:".tmp-qr-e"},x.run,bun)).toBe(0);expect(x.calls.at(-1).args[0]).toBe("run");});
test("QR child receives outer env, not secrets parsed from .env",async()=>{const dir=await mkdtemp(path.join(tmpdir(),"ctl-qr-secret-"));await mkdir(dir,{recursive:true});await writeFile(path.join(dir,".env"),"SIGHTR_VAPID_PRIVATE=secret\n");const x=harness();await qr({HERDR_PLUGIN_CONFIG_DIR:dir},x.run,bun);expect(x.calls.at(-1).opts.env.SIGHTR_VAPID_PRIVATE).toBeUndefined();await rm(dir,{recursive:true,force:true});});
test("QR refuses when Bun is unavailable",async()=>{const x=harness();await expect(qr({HERDR_PLUGIN_CONFIG_DIR:".tmp-qr-f"},x.run,async()=>"")).rejects.toThrow("bun not found");});
