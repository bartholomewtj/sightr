# T36 — Inline media and markdown file links (T3 sync `688ee52`)

Status: built 21 Oct 2026. Depends on: T13 (Files tab), T35 (markdown host). Web2 only.
Source: T3 Code `main` @ `688ee52f0e8f` (MIT). Ledger rows bumped in `web2/t3-upstream.json`.

## Problem

Two halves of the same gap in `ChatMarkdown.tsx`:

- **Media.** `![]()` and a standalone image/video are turned into a plain link today ("Images are not
  loaded"). An agent that embeds a screenshot or a rendered clip gives the operator a tap-through,
  not the picture — even though Sightr already shows tool-returned images and uploads.
- **File links.** A markdown link to a workspace path (`[main.go](web2/src/main.go)` or a relative path)
  is only a link if it is `http(s)`/`mailto`; otherwise it renders as text. Inline *code* paths already
  open the Files tab (T13's `OpenFileLink`), so the behaviour is inconsistent.

## Change

Pure modules (ported from T3 `packages/shared`, upstream header line, minor pruning of protocol/thread
branches Sightr does not use):

- `web2/src/t3/shared/path.ts`, `fileLinks.ts`, `markdownLinks.ts` — the path↔link parser: relative vs
  absolute vs `file://`, `:line:col` positions, Windows drive paths, and `resolvePathLinkTarget`.

Components:

- `web2/src/components/chat/MarkdownFileLink.logic.ts` — `resolveMarkdownFileLinkMeta(href, cwd, baseDir)`
  and `isMarkdownFileLinkLabel`, ported from T3; decides whether an `href` is a workspace file, and its
  `:line`.
- `web2/src/components/chat/MarkdownFileLink.tsx` — Sightr's own: a link chip drawn with `OpenFileLink`,
  so a workspace path opens in the Files tab (a phone's sheet).
- `web2/src/components/chat/MarkdownMedia.tsx` — `<img>`/`<video>` with `loading="lazy"`,
  `decoding="async"` and a max-width frame; `CLICKABLE` only when it can be opened full screen through
  T13's existing `ZoomableImage`/`ExpandedImageDialog`. A source that is not a safe `http(s)`/`data:image`
  URL falls back to the current link/text behaviour.

Wiring (`web2/src/components/ChatMarkdown.tsx`):

- `img` → `MarkdownMedia`; a non-image `a` whose `href` resolves to a workspace file → `MarkdownFileLink`
  (inside a thread only; thread-less callers keep the plain anchor).
- Sightr's existing safe-link rule stays for everything else.

## Invariants

- No HTML injection and no new network protocol: media loads only `http(s)`/`data:image` sources; a
  `file://` or workspace path is offered as a link chip, never fetched by the browser.
- Remote media is `loading="lazy"` so a long thread does not fetch every image on mount.
- Outside a thread, file links behave exactly as today (plain text).
- `ChatMarkdown` props are unchanged.

## Tests

- `markdownLinks.test.ts` / `fileLinks.test.ts` (ported from T3, subset).
- `MarkdownFileLink.logic.test.ts`: relative path, absolute path, `:line`, a URL that is not a file.
- `MarkdownMedia.test.tsx`: an `https` image renders `<img loading=lazy>`; a `file://` image renders the
  link/text fallback; a `.mp4` renders `<video>`.
- `ChatMarkdown.test.tsx` additions: inside a thread, a workspace-path link is a `MarkdownFileLink`;
  outside a thread it is text; an `https` image is an `<img>`.
