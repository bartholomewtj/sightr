// Windows 8.3 short names for the alias tests (T26, T30). Null off Windows, and on a volume with 8.3 name
// creation off: callers skip with a printed reason then.

/** The 8.3 short name of `longName` inside `dir` (`ENV~1` for `.env`), or null when there is none. */
export function shortNameOf(dir: string, longName: string): string | null {
  if (process.platform !== "win32") return null;
  const out = Bun.spawnSync(["cmd", "/c", "dir", "/x", "/a", dir]).stdout.toString();
  for (const line of out.split(/\r?\n/)) {
    const m = /(\S+~\d+\S*)\s+(\S.*?)\s*$/.exec(line);
    if (m && m[2] === longName) return m[1]!;
  }
  return null;
}

/** Put a tracked index entry named `alias` (a placeholder blob) into the repo at `root` and commit it. */
export async function trackAlias(git: (...args: string[]) => Promise<string>, root: string, alias: string): Promise<void> {
  const p = Bun.spawn(["git", "hash-object", "-w", "--stdin"], { cwd: root, stdin: "pipe", stdout: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "NUL", GIT_CONFIG_NOSYSTEM: "1" } });
  p.stdin.write("placeholder\n"); await p.stdin.end();
  const blob = (await new Response(p.stdout).text()).trim();
  await git("update-index", "--add", "--cacheinfo", `100644,${blob},${alias}`);
  await git("commit", "-qm", `alias ${alias}`);
}
