import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getVersion } from "./version.ts";
test("version prefers build info and falls back to manifest",async()=>{const d=await mkdtemp(path.join(tmpdir(),'sightr-'));const info=path.join(d,'build.json');await writeFile(info,JSON.stringify({version:'0.1.2',sha:'abc'}));expect(await getVersion({buildInfo:info,pluginRoot:d})).toBe('0.1.2+abc');await writeFile(info,JSON.stringify({version:'0.1.2'}));expect(await getVersion({buildInfo:info,pluginRoot:d})).toBe('0.1.2');await writeFile(path.join(d,'herdr-plugin.toml'),'version = "9.9.9"');await Bun.write(info,'bad');expect(await getVersion({buildInfo:info,pluginRoot:d})).toContain('manifest');});
