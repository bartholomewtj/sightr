import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hardenConfig } from "./perms.ts";

test("ACL hardening uses the injected icacls runner and warns only while inheritance remains", async()=>{const d=await mkdtemp(path.join(tmpdir(),'sightr-'));const e=path.join(d,'.env');await writeFile(e,'SECRET=value'); const calls:string[][]=[]; let verifyInherited=true; const run=async(cmd:string,args:string[])=>{calls.push([cmd,...args]); return {code:0,stdout:verifyInherited?'(I)':'HOST\\sam:(F)',stderr:''};}; const warning=await hardenConfig(d,e,run,{USERDOMAIN:'HOST',USERNAME:'sam'}); expect(calls.some(x=>x[0]==='icacls'&&x[1]===d&&x.includes('/inheritance:r')&&x.includes('HOST\\sam:(OI)(CI)(F)'))).toBe(true); expect(calls.some(x=>x[1]===e&&x.includes('HOST\\sam:(F)'))).toBe(true); expect(warning.join(' ')).toContain('rotate SIGHTR_VAPID_PRIVATE'); verifyInherited=false; expect(await hardenConfig(d,e,run,{USERDOMAIN:'HOST',USERNAME:'sam'})).toEqual([]);});
test("a missing icacls does not throw", async()=>{const d=await mkdtemp(path.join(tmpdir(),'sightr-')); expect(await hardenConfig(d,path.join(d,'.env'),async()=>({code:127,stdout:'',stderr:'not found'}),{USERNAME:'sam'})).toEqual([]);});
