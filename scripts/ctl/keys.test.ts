import { expect, test } from "bun:test";
import { mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { keys } from "./keys.ts";

test("keys creates the resolved config directory and forwards arguments",async()=>{const d=path.join(await mkdtemp(path.join(tmpdir(),'sightr-')),'config');let call:string[]=[];const run=async(_cmd:string,args:string[])=>{call=args;return {code:7,stdout:'',stderr:''};};const code=await keys(['--force'],{HERDR_PLUGIN_CONFIG_DIR:d,PATH:''},run);expect(code).toBe(7);expect(call).toContain(path.join(d,'.env'));expect(call.at(-1)).toBe('--force');await access(d);});
