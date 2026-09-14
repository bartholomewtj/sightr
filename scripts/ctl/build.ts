import { mkdir, rm, rename, access } from "node:fs/promises";
import path from "node:path";
import { resolveBun } from "./bun.ts";
import { resolvePaths } from "./paths.ts";
import { realRun, CtlError, type Run } from "./types.ts";

// Exported so the swap contract can be tested against a temp tree: a failed rename must put the
// live dist back.
export async function swapDist(webRoot: string): Promise<void> {
  const dist = path.join(webRoot, "dist");
  const staging = path.join(webRoot, "dist-staging");
  const backup = path.join(webRoot, "dist-backup");
  await rm(backup, { recursive: true, force: true });
  let moved = false;
  try {
    try { await access(dist); await rename(dist, backup); moved = true; } catch { /* first build has no live dist */ }
    await rename(staging, dist);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (moved) { try { await rename(backup, dist); } catch { /* preserve original error */ } }
    throw error;
  }
}

export async function build(
  env: Record<string, string | undefined> = process.env,
  run: Run = realRun,
  findBun: (env: Record<string, string | undefined>) => Promise<string> = resolveBun,
): Promise<number> {
  const bun = await findBun(env);
  if (!bun) throw new CtlError("error: bun not found on PATH", 1);
  const paths = await resolvePaths(env, run);
  const childEnv = { ...env, PATH: `${path.dirname(bun)}${path.delimiter}${env.PATH ?? ""}` } as Record<string, string>;
  const exec = async (args: string[], cwd: string) => {
    const result = await run(bun, args, { cwd, env: childEnv });
    if (result.code !== 0) throw new CtlError(`error: command failed (${args.join(" ")})`, result.code);
  };
  if (env.SKIP_VERSION_CHECK !== "1") {
    const gate = await run(bun, [path.join(paths.pluginRoot, "scripts/check-version.ts")], { cwd: paths.pluginRoot, env: childEnv });
    if (gate.code !== 0) throw new CtlError("error: version check failed", gate.code);
  }
  await exec(["install", "--frozen-lockfile"], paths.pluginRoot);
  await exec(["install", "--frozen-lockfile"], path.join(paths.pluginRoot, "web"));
  if (env.SKIP_TYPECHECK !== "1") {
    await exec(["run", "typecheck"], paths.pluginRoot);
    await exec(["run", "typecheck"], path.join(paths.pluginRoot, "web"));
  }
  const staging = path.join(paths.pluginRoot, "web/dist-staging");
  await rm(staging, { recursive: true, force: true });
  await exec(["run", "build", "--", "--outDir", "dist-staging", "--emptyOutDir"], path.join(paths.pluginRoot, "web"));
  await swapDist(path.join(paths.pluginRoot, "web"));
  await mkdir(paths.configDir, { recursive: true });
  return 0;
}
