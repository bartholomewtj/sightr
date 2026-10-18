// Pure helpers for the Git tab (T13 + git history): times and paths. (T27: the working-tree list moved to the
// Diff tab, so the helper that said which of its rows could open in Files went with it.)

/** "just now", "5m ago", "3h ago", "2d ago", "3w ago", then a short date. `time` is unix seconds. */
export function relativeTime(time: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round(nowMs / 1000 - time));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / (7 * 86_400))}w ago`;
  return new Date(time * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** A repo-relative path as a Files rel path, given the repo root's Files path (`""` is the Files root). */
export function repoFilePath(rootPath: string, path: string): string {
  return rootPath ? `${rootPath}/${path}` : path;
}

/** "↑2 ↓1 · origin/main"-style counts as words for a screen reader. */
export function syncLabel(ahead: number, behind: number, base: string): string {
  const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
  if (ahead && behind) return `${commits(ahead)} ahead of and ${behind} behind ${base}`;
  if (ahead) return `${commits(ahead)} ahead of ${base}`;
  if (behind) return `${commits(behind)} behind ${base}`;
  return `Up to date with ${base}`;
}
