// Sightr code (T25). Which file extensions the hand-rolled adapter highlights, and with which grammar.
// A plain table (no package import) so the coverage row can be computed without the highlighter installed.
export const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonl: "json", css: "css", md: "markdown", mdx: "markdown",
  html: "xml", htm: "xml", svg: "xml", xml: "xml",
  toml: "ini", ini: "ini", cfg: "ini", ps1: "powershell",
  yml: "yaml", yaml: "yaml", sh: "bash", bash: "bash", py: "python", rs: "rust",
};

export function languageForPath(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? (LANG_BY_EXT[base.slice(dot + 1).toLowerCase()] ?? null) : null;
}
