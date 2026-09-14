import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { logs } from "./logs.ts";
import type { Run } from "./types.ts";

const silentRun: Run = async () => ({code:0,stdout:"",stderr:""});

test("logs print crash files before main and error logs, honouring the line count", async () => {
  const dir=await mkdtemp(path.join(tmpdir(),"ctl-win-logs-"));
  await mkdir(dir,{recursive:true}); await writeFile(path.join(dir,"sightr-previous.log"),"old stdout\n"); await writeFile(path.join(dir,"sightr-error-previous.log"),"old stderr\n"); await writeFile(path.join(dir,"sightr.log"),"one\ntwo\nthree\n"); await writeFile(path.join(dir,"sightr-error.log"),"error\n");
  const output:string[]=[]; const original=console.log; console.log=(...args:any[])=>output.push(args.join(" "));
  try { await logs(["2"],{HERDR_PLUGIN_CONFIG_DIR:dir},silentRun); } finally { console.log=original; await rm(dir,{recursive:true,force:true}); }
  const text=output.join("\n");
  expect(text).toContain("previous bridge crash (stdout):"); expect(text).toContain("previous bridge crash (stderr):"); expect(text).toContain("two"); expect(text).toContain("three"); expect(text).not.toContain("one\n"); expect(text).toContain("error");
  expect(output.filter(line=>line.includes("previous bridge crash")).length).toBe(2);
});
test("missing main log prints no log and no crash headers", async()=>{const dir=await mkdtemp(path.join(tmpdir(),"ctl-win-missing-"));const output:string[]=[];const original=console.log;console.log=(...args:any[])=>output.push(args.join(" "));try{await logs([], {HERDR_PLUGIN_CONFIG_DIR:dir},silentRun);}finally{console.log=original;await rm(dir,{recursive:true,force:true});}expect(output).toContain("(no log)");expect(output.some(x=>x.includes("previous bridge crash"))).toBe(false);});
