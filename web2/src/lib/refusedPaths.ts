// Sightr code (T29). Comments quote file content, so the Files refusal list applies to them. The bridge counts refused
// paths without sending them (`isHiddenPath` in bridge/workdir-git.ts), so T26's lists never show one; but T24/T27's run
// scope shows `file_change.fileName` straight from the journal, and that can be anything. `isRefusedName` below is a
// copy of bridge/workdir.ts `isRefusedName` (web2 does not import the bridge); its test is the table from
// bridge/workdir.test.ts. Keep the two in step.

export function isRefusedName(name: string): boolean {
  if (name.startsWith(".")) return true;
  const lower = name.toLowerCase();
  if (["node_modules", "config", "__pycache__", "venv", "target", "vendor", "adws", "thumbs.db", "desktop.ini"].includes(lower)) return true;
  return /\.(pem|key|pfx|p12|kdbx|keystore|jks)$/i.test(name) || /^id_(rsa|ecdsa|ed25519)/i.test(name);
}

export type CommentPathProblem = "unsafe" | "refused";

/**
 * Why a comment cannot be made on this path, or null. `unsafe`: not a repo-relative forward-slash path (absolute,
 * a drive letter, `..`, a backslash, a colon, an empty or control-character segment, more than 32 segments). `refused`: some segment is on the
 * Files refusal list.
 */
export function commentPathProblem(path: string): CommentPathProblem | null {
  if (path === "" || path.length > 1024 || /[\u0000-\u001f\\]/.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "unsafe";
  const parts = path.split("/");
  // The bridge's `parseRelPath` also refuses a `:` in a segment and more than 32 segments.
  if (parts.length > 32 || parts.some((p) => p === "" || p === "." || p === ".." || p.includes(":"))) return "unsafe";
  return parts.some(isRefusedName) ? "refused" : null;
}

export const COMMENT_PATH_REASON: Record<CommentPathProblem, string> = {
  unsafe: "Comments are off for this file: its path is not a plain path inside the repo.",
  refused: "Comments are off for this file: it is on the Files refusal list (secrets, keys, dot files).",
};
