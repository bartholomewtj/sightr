import { expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveBun } from "./bun.ts";
test("resolveBun uses BUN_INSTALL absolute candidate",async()=>{const d=await mkdtemp(path.join(tmpdir(),'sightr-'));const bin=path.join(d,'bin');await mkdir(bin);await Bun.write(path.join(bin,'bun.exe'),'');const found=await resolveBun({BUN_INSTALL:d,PATH:''});expect(path.isAbsolute(found)).toBe(true);});
test("resolveBun rejects relative PATH entries",async()=>{const found=await resolveBun({BUN_INSTALL:'relative/dir',PATH:'relbin'}); expect(path.isAbsolute(found)).toBe(true); expect(found).not.toContain('relative'); expect(found).not.toContain('relbin');});
