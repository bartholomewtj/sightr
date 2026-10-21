# T35 — Markdown rendering foundation (T3 sync `688ee52`)

Status: built 21 Oct 2026. Depends on: T11 (timeline markdown). Web2 only: no bridge or `shared/` change.
Source: T3 Code `main` @ `688ee52f0e8f` (MIT, `web2/THIRD_PARTY.md`). Ledger rows bumped in `web2/t3-upstream.json`.

## Problem

Sightr's `ChatMarkdown.tsx` was ported at T3 `e3b35d1b` with a deliberately small surface (spec T11): no
syntax highlighting, no Mermaid, no LaTeX, no GitHub alerts, no table copy/expand. Agents
now emit all of these routinely, so a phone reads raw TeX, raw `mermaid` fences, pasted callouts and long
collapsed transcripts. T3 has since built each of these as a small, mostly-pure module (`packages/shared`,
`apps/web/src/components/chat`), so they port without the rest of T3's ChatMarkdown.

## Change

Pure modules (ported from T3, with the upstream header line; no `react`/Effect/Tiptap imports):

- `web2/src/t3/shared/markdownGithubAlerts.ts` — remark plugin for `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`,
  tagging the blockquote `dataAlert`.
- `web2/src/t3/shared/markdownListIndentation.ts` — remark plugin that recovers a four-space-indented block
  that CommonMark reads as a code block inside a list item.
- `web2/src/components/chat/MarkdownCodeBlock.logic.ts` — `extractFenceLanguage`, `extractFenceTitle`
  (`title=`/filename), `extractPreCodeMeta`, `isClosedCodeFence`, `nodeToPlainText` (ported verbatim).

Components (Sightr's own bodies, same job and name as T3):

- `web2/src/components/chat/MarkdownCodeBlock.tsx` — the `pre` renderer: highlights with the `highlight.js`
  Sightr already ships (not Shiki), shows the fence title when present, keeps the "Wrap lines" toggle and
  Copy, and draws the highlighted code as spans over the plain code so selection/copy still yields text.
- `web2/src/lib/markdown-clipboard.ts` — `serializeTableElementToMarkdown` / `…ToCsv` from a rendered table.
- `web2/src/components/chat/MarkdownTable.tsx` — the `table` renderer: T3's Copy (Markdown/CSV) and a
  wrap/expand toggle shown only when a cell is clipped.
- Math is rendered by the standard `remark-math` + `rehype-katex` pair (KaTeX). No custom math
  component is ported: T3's `MarkdownMath`/`MathTypeset` exist to lazy-load KaTeX and keep a raw-TeX
  fallback, which `rehype-katex` with `throwOnError: false` already gives. Sightr adds the KaTeX CSS and
  two `.chat-markdown` styles (display/scroll) instead.
- `web2/src/components/chat/MarkdownMermaidCodeBlock.tsx`, `MermaidDiagram.tsx` — a ` ```mermaid ` fence
  renders through `pele` (lazy, one chunk per diagram type) with a Show code / Show diagram toggle; any
  load or parse failure degrades to the highlighted code block.

Wiring (`web2/src/components/ChatMarkdown.tsx`):

- Remark plugins: `remarkGfm`, `remarkGithubAlerts`, `remarkNormalizeListItemIndentation`, and (only when
  the text may contain math) `[remarkMath, { singleDollarTextMath: true }]`, plus the existing
  `remarkHtmlAsText` (Sightr's no-injection rule) and, for `lineBreaks`, `remarkBreaks`.
- Rehype plugins: `rehypeKatex` only. Raw HTML is still turned into text at the remark stage, so KaTeX's
  own hast output is the only HTML-shaped content that reaches the DOM.
- Components: `pre` → `MarkdownCodeBlock`, `table` → `MarkdownTable`; the math nodes become KaTeX
  markup through `rehype-katex`. `a`/`img`/inline `code` are unchanged here and are wired in T36.
- `web2/package.json` gains `remark-math`, `rehype-katex`, `katex`, `pele` (versions T3 pins, except KaTeX
  which T3 has at the same 0.16 line). `katex/dist/katex.min.css` and the `.chat-markdown` alert/math
  styles are imported once from `web2/src/index.css` additions.

## Not here

- **`<details>` collapsibles.** T3 renders them from raw HTML (`rehype-raw`). Sightr's no-injection rule
  turns every HTML node into text, so `<details>` markdown shows as its literal tags; no `details` node is
  ever produced, so no renderer is ported or wired. Revisit only if a narrow safe-HTML allowance is
  designed.
- **Citations, skill chips, Codex artifact directives, incremental parsing** stay upstream.

## Invariants

- No `rehype-raw`/`rehype-sanitize`; HTML in a message still renders as text. KaTeX is the only new
  HTML-producing plugin and it runs after the html→text pass.
- No harness id is branched on; nothing here reads `shared/agents.ts`.
- A code block, a table, a diagram and a formula all keep a copy path that yields the authored source.
- `ChatMarkdown` stays a default export taking the same props; callers are unchanged.
- Mermaid and math never block a render: a failure falls back to the code block / raw TeX.

## Tests

- `markdownGithubAlerts.test.ts`, `markdownListIndentation.test.ts` (ported from T3).
- `MarkdownCodeBlock.logic.test.ts` (ported): fence language, `title=`, bare filename, closed-fence.
- `MarkdownTable.test.tsx`: copy Markdown and CSV, expand toggle only when clipped.
- `ChatMarkdown.test.tsx` additions: `$x^2$` renders a `.katex` node and its TeX stays copyable; a
  `> [!NOTE]` block carries `data-alert`; a ` ```mermaid ` fence is a `MarkdownMermaidCodeBlock` (mock
  `pele`) and falls back to code when `pele` rejects. `ChatMarkdown.test.tsx` asserts HTML still renders
  as text and that highlighting does not change the code text.
- Not checked live on a phone: KaTeX/Mermaid paint cost on a long thread.
