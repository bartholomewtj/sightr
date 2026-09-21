import { homedir } from "node:os";

import { resolveStateDir } from "../../bridge/beacon/paths.ts";
import { loadConfig } from "../../bridge/config.ts";
import { Push } from "../../bridge/push.ts";
import { effectiveEnv } from "./env.ts";
import { CtlError, realRun, type Run } from "./types.ts";

async function openStore(
  env: Record<string, string | undefined> = process.env,
  run: Run = realRun,
): Promise<Push> {
  const { effective } = await effectiveEnv(env, run);
  const push = new Push({ ...loadConfig(), stateDir: resolveStateDir(effective, homedir()) });
  await push.loadStore();
  return push;
}

/** Print persisted push rows (endpoint, createdAt, userAgent — never keys). */
export async function pushList(
  env: Record<string, string | undefined> = process.env,
  run: Run = realRun,
  log: (line: string) => void = console.log,
): Promise<number> {
  const rows = (await openStore(env, run)).listSubscriptions();
  if (rows.length === 0) log("no push subscriptions");
  else log(JSON.stringify(rows, null, 2));
  return 0;
}

/** Drop rows whose endpoint contains `match`, or all of them for `*`. Require an explicit match. */
export async function pushForget(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  run: Run = realRun,
  log: (line: string) => void = console.log,
): Promise<number> {
  const match = args[0];
  if (!match) throw new CtlError("usage: sightr-ctl.ps1 push-forget <match|*>", 2);
  const n = await (await openStore(env, run)).forget(match);
  log(`forgot ${n} subscription(s)`);
  return 0;
}
