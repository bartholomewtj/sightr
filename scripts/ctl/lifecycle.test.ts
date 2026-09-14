import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Run } from "./types.ts";
import { start } from "./lifecycle.ts";

const secret = "super-secret-signing-key";

async function temp() {
  const dir = await mkdtemp(path.join(tmpdir(), "sightr-"));
  await mkdir(path.join(dir, "web/dist"), { recursive: true });
  await writeFile(path.join(dir, "web/dist/index.html"), "<html>");
  await writeFile(path.join(dir, ".env"), `SIGHTR_VAPID_PRIVATE=${secret}\n`);
  await writeFile(path.join(dir, "sightr.log"), "");
  return dir;
}
function capture() {
  const logs: string[] = [];
  const orig = console.log; const err = console.error;
  console.log = (...a) => { logs.push(a.join(" ")); };
  console.error = (...a) => { logs.push(a.join(" ")); };
  return { logs, restore() { console.log = orig; console.error = err; } };
}

test("a failing serve does not abort start", async () => {
  const dir = await temp();
  const cap = capture();
  const run: Run = async (cmd) => {
    if (cmd === "tailscale") return { code: 127, stdout: "", stderr: "" };
    if (cmd === "herdr") return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "Ready", stderr: "" };
  };
  try {
    // start() then prints status, which keeps probing the port while nothing is listening (CI) — keep that short here.
    expect(await start({ HERDR_PLUGIN_CONFIG_DIR: dir, HOME: dir, USERPROFILE: dir, SIGHTR_PORT: "59999", SIGHTR_TASK_NAME: "herdr.sightr-test" }, run, { waitMs: 1000 })).toBe(0);
  } finally { cap.restore(); }
  expect(cap.logs.join("\n")).toContain("the tailnet front door did not come up");
  expect(cap.logs.join("\n")).toContain("bridge started (Task Scheduler: herdr.sightr-test)");
}, 15_000);
