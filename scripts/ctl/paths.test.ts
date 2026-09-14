import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePaths } from "./paths.ts";

test("injected config directory wins",async()=>{const d=await mkdtemp(path.join(tmpdir(),'sightr-')); const p=await resolvePaths({HERDR_PLUGIN_CONFIG_DIR:d,USERPROFILE:tmpdir(),PATH:''},async()=>({code:0,stdout:'/wrong\n',stderr:''})); expect(p.configDir).toBe(d); expect(p.envFile).toBe(path.join(d,'.env'));});
test("herdr config result is used",async()=>{const d=await mkdtemp(path.join(tmpdir(),'sightr-')); const p=await resolvePaths({USERPROFILE:tmpdir(),PATH:''},async()=>({code:0,stdout:d+'\n',stderr:''})); expect(p.configDir).toBe(d);});
test("falls back to Herdr's conventional AppData path when Herdr is not answering",async()=>{const home=await mkdtemp(path.join(tmpdir(),'sightr-')); const p=await resolvePaths({USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),PATH:''},async()=>({code:1,stdout:'',stderr:''})); expect(p.configDir).toBe(path.join(home,'AppData/Roaming/herdr/plugins/config/herdr.sightr'));});
test("derives AppData from the profile when APPDATA is unset",async()=>{const home=await mkdtemp(path.join(tmpdir(),'sightr-')); const p=await resolvePaths({USERPROFILE:home,PATH:''},async()=>({code:1,stdout:'',stderr:''})); expect(p.configDir).toBe(path.join(home,'AppData','Roaming','herdr/plugins/config/herdr.sightr'));});
