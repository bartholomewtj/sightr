import { realRun, type Run } from "./types.ts";

// NTFS analogue of chmod 700/600: strip inherited ACEs and grant only the current user Full Control.
// Directories grant (OI)(CI) so later files (exec-bridge.vbs) inherit. Failure warns; start must not brick over an ACL it can't set.
export async function hardenConfig(dir: string, envFile: string, run: Run = realRun, env: Record<string,string|undefined> = process.env): Promise<string[]> {
  const warnings: string[] = [];
  const user = env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : (env.USERNAME ?? "");
  const protect = async (target: string, directory: boolean) => {
    const grant = directory ? `${user}:(OI)(CI)(F)` : `${user}:(F)`;
    await run("icacls", [target, "/inheritance:r", "/grant:r", grant]);
    const verify = await run("icacls", [target]);
    if (verify.code === 0 && (verify.stdout.includes("(I)") || !verify.stdout.toLowerCase().includes(`${user.toLowerCase()}:(f)`))) warnings.push(`warn: ${target} ACL still allows other users; rotate SIGHTR_VAPID_PRIVATE if other users have accounts on this host.`);
  };
  try { await protect(dir, true); if (await Bun.file(envFile).exists()) await protect(envFile, false); } catch { /* ACL unavailable: do not brick start */ }
  return warnings;
}
