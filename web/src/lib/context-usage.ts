// Pull a context-window figure out of TUI chrome. Claude paints `ctx:33%` / `CTX:20%` on the
// statusline; Grok's optional status line paints `12% ctx`; Grok's header paints `20K / 500K`
// (used / window); Pi's footer paints `4.1%/200k (auto)` (fill / window). The pane-details
// sheet shows that number as a labeled row so it is readable even when the raw statusline is a
// wall of other fields, or when the statusline extractor returned nothing but the dump still
// has the token.
//
// Prefer a labeled percentage (fill level). Then Pi's percent/window. Then Grok's used/window.
// A k-token count without a window size is not a fill level — return null rather than guess.

const PCT = [/\bctx[:\s]*(\d{1,3})%/i, /(\d{1,3})%\s*ctx\b/i];
// Pi: `4.1%/200k` or `4.1% / 200k`. Window side must carry K/M so `5h:22%/1h:20m` does not match.
const PI = /\b(\d{1,3}(?:\.\d)?%)\s*\/\s*(\d{1,3}(?:\.\d)?[KMkm])\b/;
// Window side must carry K/M so `2026/09` and `src/lib` do not match. Used may be bare (`500 / 1.0M`).
const TOKENS = /\b(\d{1,3}(?:\.\d)?[KMkm]|\d{1,4})\s*\/\s*(\d{1,3}(?:\.\d)?[KMkm])\b/;

/** A fill level (`"33%"`), Pi `"4.1%/200k"`, or Grok `"20K/500K"`, or null when the text has none. */
export function contextUsageFrom(text: string): string | null {
  for (const re of PCT) {
    const m = re.exec(text);
    if (m === null) continue;
    const n = Number(m[1]);
    if (n >= 0 && n <= 100) return `${n}%`;
  }
  const pi = PI.exec(text);
  if (pi !== null) return `${pi[1]}/${pi[2]}`;
  const t = TOKENS.exec(text);
  return t === null ? null : `${t[1]}/${t[2]}`;
}
