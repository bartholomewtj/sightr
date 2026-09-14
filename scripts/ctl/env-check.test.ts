import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { envCheck } from "./env-check.ts";

test("env-check reports names but not values",async()=>{const d=await mkdtemp(path.join(tmpdir(),'sightr-'));await writeFile(path.join(d,'.env'),'PUBLIC=yes\nBROKEN secret-value\nSECRET=s3cret-value\n');const oldOut=console.log,oldErr=console.error;let out='',err='';console.log=(...x)=>{out+=x.join(' ') };console.error=(...x)=>{err+=x.join(' ')};try{expect(await envCheck({HERDR_PLUGIN_CONFIG_DIR:d,PATH:''},async()=>({code:0,stdout:'',stderr:''}))).toBe(0);}finally{console.log=oldOut;console.error=oldErr}expect(out).toContain(d);expect(out).toContain('PUBLIC');expect(out).not.toContain('s3cret-value');expect(err).toContain('malformed');expect(err).not.toContain('secret-value');});
test("absent .env exits successfully",async()=>{const d=await mkdtemp(path.join(tmpdir(),'sightr-')); let out=''; const old=console.log; console.log=(...x)=>{out+=x.join(' ')}; try { expect(await envCheck({HERDR_PLUGIN_CONFIG_DIR:d,PATH:''},async()=>({code:0,stdout:'',stderr:''}))).toBe(0); } finally { console.log=old; } expect(out).toContain('exists: no'); expect(out).toContain('keys: (none)'); });
