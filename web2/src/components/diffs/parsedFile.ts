// Sightr code (T25). What every diff adapter does first: take the one file out of the patch.
import { useMemo } from "react";
import { parsePatch, type ParsedPatchFile } from "./parsePatch.ts";

const EMPTY: ParsedPatchFile = { path: "", status: "modified", hunks: [], additions: 0, deletions: 0, unknown: [] };

/** The first file of `patch` (a seam patch holds one), or the caller's `parsed` when it already has it. */
export function useParsedFile(patch: string, parsed?: ParsedPatchFile): ParsedPatchFile {
  return useMemo(() => parsed ?? parsePatch(patch)[0] ?? EMPTY, [patch, parsed]);
}

/** The file's hunks as unified-diff lines (`@@` header, then prefixed text), the shape `DiffLines` draws. */
export function unifiedLines(file: ParsedPatchFile): string[] {
  const out: string[] = [];
  for (const h of file.hunks) {
    out.push(h.header);
    for (const l of h.lines) out.push((l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text);
  }
  if (out.length === 0) out.push(file.status === "binary" ? "Binary file" : file.status === "renamed" ? "Renamed, no content change" : "No changes to show");
  return out;
}
