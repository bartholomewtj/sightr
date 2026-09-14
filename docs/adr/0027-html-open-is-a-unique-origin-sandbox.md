# ADR 0027: HTML from the work root opens as a unique-origin sandbox

Date: 2026-08-22

Status: **Accepted**

## Context

ADR 0026 refused inline HTML because a `text/html` response from `/api/files/open` would run
same-origin with the bridge — a typed keystroke into a real terminal one CSP bypass away. 0.54.0
then allowed Open in browser for types Chrome can display, still excluding HTML/SVG/XML/JS.

The Files tab is how the operator reads their own work on a phone. HTML documents (reports, spec
pages, generated pages) are useful there, and Download-only is a worse phone path than Open in
browser. Serving them as Collie would reopen the hole ADR 0026 closed.

Two other roads were rejected:

- *Same-origin `text/html` with Collie's own CSP.* Collie's CSP allows `script-src 'self'`. A work
  file is not Collie's bundle; it would still be Collie's origin.
- *A sandboxed iframe in the Files tab.* Relative assets still fail, PDF already taught us not to
  iframe on iOS, and a new-tab open is the affordance that already exists.

SVG/XML/JS stay out. SVG as a document is scriptable and is not given this sandbox; do not copy
the HTML exception to those types without a new ADR.

## Decision

Allow `.html` / `.htm` on `GET /api/files/open` as `text/html` **only** with
`Content-Security-Policy: sandbox` and no `allow-same-origin` / `allow-scripts` (plus `script-src
'none'` so a browser that ignores top-level `sandbox` still cannot run the file). Do not embed
HTML in the Files tab. Downloads stay `attachment` with no HTML CSP.

## Consequences

Scripts in the opened page do not run; forms do not post; the page cannot call Collie's `/api/*`.
Relative images/CSS often 404 because the open URL is `/api/files/open?path=…` — self-contained
HTML is the case this is for. Adding `allow-scripts` or `allow-same-origin` is a new ADR, not a
PR. SVG/XML/JS remaining download-only is deliberate.
