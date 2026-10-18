// Test stand-in for highlight.js (aliased in vitest.config.ts, so the hand adapter runs in CI without the package).
// It wraps a few keywords in the same `<span class="hljs-keyword">` markup the real core returns, escaped the way
// the real one escapes, which is all `hand.highlight.ts` reads.
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const known = new Set<string>();

export default {
  highlight(code: string, _opts: { language: string; ignoreIllegals: boolean }) {
    return { value: escape(code).replace(/\b(const|function|return|import)\b/g, '<span class="hljs-keyword">$1</span>') };
  },
  registerLanguage(name: string, _def: unknown) {
    known.add(name);
  },
  getLanguage(name: string) {
    return known.has(name) ? {} : undefined;
  },
};
