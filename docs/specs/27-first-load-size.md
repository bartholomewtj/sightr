# 27 — The first thread open is not 1.7 MB of bundle

Status: open. Written 22 Oct 2026 from the Phase 1 live check (spec 26). Part of the responsiveness
work in [`../ARCHITECTURE-ASSESSMENT.md`](../ARCHITECTURE-ASSESSMENT.md).

## Problem

Spec 26 bounded the thread snapshot and gzipped it: opening `FL` now sends a 135 KB frame instead of
1.5 MB, and the bridge builds it in ~34 ms. The live check still felt slow (2–3 s on 4G) because the
bundle around that frame was never compressed.

The v2 app is served from `web2/dist` by `bridge/static-assets.ts`, which returned
`new Response(Bun.file(full), { headers })` for every file — no `Content-Encoding`, `Accept-Encoding`
ignored. Measured against the built tree:

| | |
|---|---|
| The thread route's static import closure | **1,725 KB raw** (27 chunks) |
| Biggest chunk | `itemJump-*.js`, 722 KB raw |
| …which carries | KaTeX (266 KB raw), pulled in by the eager `rehype-katex` import in `ChatMarkdown.tsx` |
| Service-worker precache | 3,105 KB raw |

Over 4G that is the delay.

## Change

- `bridge/static-assets.ts`
  - Gzip a served file when the request's `Accept-Encoding` includes `gzip`, the extension is
    compressible (`.js .mjs .css .html .svg .json .webmanifest .map .txt`) and it is at least
    `STATIC_GZIP_MIN_BYTES` (1024). The gzipped bytes are memoised per absolute path and invalidated
    by mtime, so a hashed asset is compressed once per build. `vary: accept-encoding` is set on every
    compressible response, whether or not this one was compressed, so no shared cache hands a gzipped
    body to a client that cannot read it.
  - `serveStatic` takes the header as a new optional last argument; `bridge/server.ts` passes it.
- `web2/src/lib/suspend.ts` — `suspendOn`, React's throw-a-promise pattern, lifted out of
  `MermaidDiagram.tsx` so both lazy renderers share it.
- `web2/src/components/ChatMarkdown.tsx` — `rehype-katex` becomes a dynamic `import()` behind a
  module-level memo, reached only for text that matches `MATH_HINT`. Text without a formula renders
  through a new `MarkdownBody` with no math pass and never suspends; text with one renders that same
  body as the `<Suspense>` fallback (so the raw TeX shows, not a blank reply) until KaTeX lands.
- `CHANGELOG.md`.

## Invariants

- Compression never changes which bytes a client gets, only their encoding; a client that does not
  send `gzip` gets the file exactly as before.
- Only a compressible type is touched; images, icons and fonts pass through untouched.
- KaTeX is still the same plugin with the same options (`throwOnError: false, strict: false`); a
  formula KaTeX cannot parse still keeps its raw TeX.
- No new contract field, no harness-id branching; `shared/` is untouched.

## Tests

- `bridge/static-assets.test.ts`: a compressible asset gzips and gunzips back to the same bytes with
  its cache and build headers intact; the same asset is untouched without the header; a `.png` and a
  sub-threshold file are not compressed; the memo returns identical bytes on a second request.
- `web2/src/components/ChatMarkdown.test.tsx`: math still typesets (now after the lazy load), an
  unparsable formula keeps its raw TeX, and text with no formula never touches KaTeX.
- Live: `curl` the built chunks and the thread route before/after; the closure goes 1,725 KB raw →
  1,463 KB raw and 467 KB gzipped.
