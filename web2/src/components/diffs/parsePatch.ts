// Sightr code (T25). A hunk-aware unified-diff splitter. The older `parseDiff` (right-panel/DiffView.tsx)
// guesses headers with a regex, so a removed line whose text starts `-- ` (shown as `--- `) looks like a
// header and vanishes, and a quoted name such as "a/caf\303\251.ts" is never decoded. This parser reads
// each hunk header's counts and, while lines are still owed, takes every row as body whatever it looks
// like; when a hunk's body disagrees with its header it says so (`mismatch`) and trusts the body.
import { gitPatchSidePath, unquoteGitPatchPath } from "@shared/v2/gitPatchPath";

export type PatchFileStatus = "modified" | "added" | "deleted" | "renamed" | "binary";

export type ParsedLine = {
  kind: "context" | "add" | "del";
  /** The line without its +/-/space prefix. A CRLF file keeps its `\r` here. */
  text: string;
  /** 1-based, from the hunk header; absent on the side the line is not part of. */
  oldLine?: number;
  newLine?: number;
  /** Git's `\ No newline at end of file` followed this line; it counts toward neither side. */
  noEol?: boolean;
};

export type ParsedHunk = {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Text after the closing `@@` (git puts the enclosing function there). */
  section: string;
  lines: ParsedLine[];
  /** Set when the body held other counts than the header declared. The body is what was parsed. */
  mismatch?: { declaredOld: number; declaredNew: number; actualOld: number; actualNew: number };
};

export type ParsedPatchFile = {
  path: string;
  oldPath?: string;
  status: PatchFileStatus;
  hunks: ParsedHunk[];
  additions: number;
  deletions: number;
  /** `similarity index` of a rename or copy, 0-100. */
  similarity?: number;
  /** Header rows that were neither understood nor part of a hunk. */
  unknown: string[];
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const GIT_HEADER = "diff --git ";

/** Reads `"..."` or a bare token off the front of `s`; returns [decoded name, rest]. */
function takeToken(s: string): [string, string] | null {
  if (s.startsWith('"')) {
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\") i++;
      else if (s[i] === '"') return [unquoteGitPatchPath(s.slice(0, i + 1)), s.slice(i + 1).replace(/^ /, "")];
    }
    return null;
  }
  const sp = s.indexOf(" ");
  return sp < 0 ? [s, ""] : [s.slice(0, sp), s.slice(sp + 1)];
}

const stripSide = (name: string) => (/^[ab]\//.test(name) ? name.slice(2) : name);

/** The two names on a `diff --git` line. A bare name with spaces is split where both halves agree. */
function parseGitHeader(rest: string): { oldPath: string; path: string } | null {
  if (rest.startsWith('"') || /^\S+ "/.test(rest)) {
    const first = takeToken(rest);
    const second = first && takeToken(first[1]);
    if (first && second && second[1] === "") return { oldPath: stripSide(first[0]), path: stripSide(second[0]) };
  }
  for (let i = rest.indexOf(" b/"); i >= 0; i = rest.indexOf(" b/", i + 1)) {
    const left = rest.slice(0, i);
    const right = rest.slice(i + 1);
    if (left.startsWith("a/") && left.slice(2) === right.slice(2)) return { oldPath: left.slice(2), path: right.slice(2) };
  }
  const i = rest.indexOf(" b/");
  return i > 0 ? { oldPath: stripSide(rest.slice(0, i)), path: stripSide(rest.slice(i + 1)) } : null;
}

/** `--- a/x` / `+++ b/x` names (the shared decoder: unquoted, side prefix off, a tab ends the name, `/dev/null` is null). */
const parseMarker = gitPatchSidePath;

/** One file's header facts, gathered until its first hunk and resolved by `settle`. */
type Pending = {
  file: ParsedPatchFile;
  from?: string;
  to?: string;
  oldMarker?: string | null;
  newMarker?: string | null;
};

function settle(p: Pending | null): void {
  if (!p) return;
  const f = p.file;
  if (p.newMarker) f.path = p.newMarker;
  else if (p.newMarker === null && p.oldMarker) f.path = p.oldMarker;
  if (p.to) f.path = p.to;
  const from = p.from ?? p.oldMarker ?? undefined;
  if (from && from !== f.path) f.oldPath = from;
  if (f.status === "modified" && f.hunks.length > 0) {
    if (p.oldMarker === null) f.status = "added";
    else if (p.newMarker === null) f.status = "deleted";
  }
}

/** Splits a (multi-file) unified or `git diff` patch into files, hunks and numbered lines. */
export function parsePatch(patch: string): ParsedPatchFile[] {
  const files: ParsedPatchFile[] = [];
  if (!patch.trim()) return files;
  const rows = patch.split("\n"); // "\n" only: a CRLF file's "\r" stays in the text and is not a line
  if (rows[rows.length - 1] === "") rows.pop();
  let cur: Pending | null = null;
  let inHeader = false;

  const open = (): Pending => {
    settle(cur);
    cur = { file: { path: "", status: "modified", hunks: [], additions: 0, deletions: 0, unknown: [] } };
    files.push(cur.file);
    inHeader = true;
    return cur;
  };

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (row.startsWith(GIT_HEADER)) {
      const p = open();
      const names = parseGitHeader(row.slice(GIT_HEADER.length));
      if (names) {
        p.file.path = names.path;
        if (names.oldPath !== names.path) p.file.oldPath = names.oldPath;
      }
      continue;
    }
    const m = HUNK.exec(row);
    if (m) {
      const p = cur ?? open();
      const f = p.file;
      inHeader = false;
      const hunk: ParsedHunk = {
        header: row,
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] ?? "",
        lines: [],
      };
      let oldLeft = hunk.oldCount;
      let newLeft = hunk.newCount;
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      let actualOld = 0;
      let actualNew = 0;
      let last: ParsedLine | undefined;
      for (r++; r < rows.length; r++) {
        const line = rows[r];
        const c = line[0];
        const owing = oldLeft > 0 || newLeft > 0;
        if (c === "\\") {
          if (last) last.noEol = true;
          continue;
        }
        if (!owing) {
          // The counts are spent, so the next header ends the hunk; anything else that is still
          // body-shaped is kept and reported as a count mismatch.
          if (line.startsWith(GIT_HEADER) || HUNK.test(line)) break;
          if (line.startsWith("--- ") && (rows[r + 1] ?? "").startsWith("+++ ")) break;
        }
        if (c === "+") {
          last = { kind: "add", text: line.slice(1), newLine: newNo++ };
          newLeft--;
          actualNew++;
          f.additions++;
        } else if (c === "-") {
          last = { kind: "del", text: line.slice(1), oldLine: oldNo++ };
          oldLeft--;
          actualOld++;
          f.deletions++;
        } else if (c === " " || (owing && line === "")) {
          // An editor that strips trailing blanks turns an empty context line into "".
          last = { kind: "context", text: line.slice(1), oldLine: oldNo++, newLine: newNo++ };
          oldLeft--;
          newLeft--;
          actualOld++;
          actualNew++;
        } else break;
        hunk.lines.push(last);
      }
      r--;
      if (actualOld !== hunk.oldCount || actualNew !== hunk.newCount) {
        hunk.mismatch = { declaredOld: hunk.oldCount, declaredNew: hunk.newCount, actualOld, actualNew };
      }
      f.hunks.push(hunk);
      continue;
    }
    // Plain `diff -u` has no `diff --git` row: a `--- ` / `+++ ` pair outside a header starts a file.
    if (row.startsWith("--- ") && !inHeader && (rows[r + 1] ?? "").startsWith("+++ ")) open();
    if (!cur) continue; // text before the first file (a mail header, a commit message)
    const p: Pending = cur;
    const f = p.file;
    if (row.startsWith("--- ")) p.oldMarker = parseMarker(row.slice(4));
    else if (row.startsWith("+++ ")) p.newMarker = parseMarker(row.slice(4));
    else if (row.startsWith("new file mode")) f.status = "added";
    else if (row.startsWith("deleted file mode")) f.status = "deleted";
    else if (row.startsWith("rename from ")) { p.from = unquoteGitPatchPath(row.slice(12)); f.status = "renamed"; }
    else if (row.startsWith("rename to ")) { p.to = unquoteGitPatchPath(row.slice(10)); f.status = "renamed"; }
    else if (row.startsWith("copy from ")) p.from = unquoteGitPatchPath(row.slice(10));
    else if (row.startsWith("copy to ")) { p.to = unquoteGitPatchPath(row.slice(8)); if (f.status === "modified") f.status = "added"; }
    else if (/^(dis)?similarity index /.test(row)) f.similarity = Number(/(\d+)%/.exec(row)?.[1]) || undefined;
    else if (/^(Binary files .* differ|GIT binary patch)/.test(row)) f.status = "binary";
    else if (f.status === "binary" || /^(index |old mode |new mode )/.test(row) || row === "") { /* noise, or base85 data */ }
    else f.unknown.push(row);
  }
  settle(cur);
  return files;
}
