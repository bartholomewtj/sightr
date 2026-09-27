# 19 — Long-send verify on every adapter

> **Status 2026-09-27:** PARTLY DONE.
> - **Cursor:** `draftCarriesSend` / `draftIsOpaque` through the shared `harness/paste-token.ts`. Cursor's `+M lines` counts lines; live-probed and pinned in `cursor--draft-paste-placeholder.txt`.
> - **Agy:** has no token (long text inserts literally), so it needs no verifier. The live probe found a worse problem: raw newlines in a long send submit part of it. That is a separate fix, not this spec.
> - **Pi:** stays on the named one-shot path (`replyOneShot: true`).
> - **Left:** the no-adapter (Codex) long send still one-shots. There is no evidence for what a hold would buy there; README troubleshooting now says so.
>
> **Status 2026-09-27 (`874b85b`):** OPEN. Pi takes the one-shot path explicitly (`replyOneShot: true`, `web/src/lib/harness/pi/index.ts`); name it here.

Council row 19. Severity: medium. Parser.

## Why

ADR 0010: long sends are verified via the paste placeholder, not by chunking. `draftCarriesSend` exists on Claude (`claude/paste.ts`) and Grok image chips (`chipCarriesSend`). Cursor/Agy/Pi have none as adapter methods (Cursor tests call the generic `draftCarriesSend` in `actions.ts` against extracted draft text — that is not a paste-boundary token). Codex has no adapter so `sendGuardedReply` one-shots. `STATE.md` records Herdr paste-boundary as Codex-only in **live herdr** — that is a Herdr limitation, not something this repo can flip. Do not claim a Herdr-wide paste marker that the socket does not emit.

## Do

- Implement `adapter.draftCarriesSend` on Cursor and Agy (and Pi if it has a visible draft) using the same “does this screen carry our send” idea as Claude/Grok — extracted draft / chips, **not** a fake Herdr token.
- If Herdr’s paste-boundary token is present on a `pane.send_text` response or dump for any harness, verify against that token (ADR 0010). If it is absent, do **not** one-shot a long send and then report success: keep Enter withheld or report unverified, matching Claude’s fail-closed posture.
- Codex / no-adapter: stop silently one-shotting long sends without a verify. Either use a paste placeholder if Herdr supplies one, or refuse/hold Enter and surface the existing failure status. Document the Codex-only Herdr gap in README troubleshooting if it remains.

## Do not

- Patch Herdr. Do not add a Herdr method name outside `bridge/herdr-client.ts`.
- Chunk the send (ADR 0010 forbids it).
- Split `actions.ts` in this slice (row 12) — add the adapter methods and the no-adapter fail-closed branch only.
- Wait for a future Herdr release as the definition of done.

## Files

| File | Change |
|---|---|
| `web/src/lib/harness/cursor/` | `draftCarriesSend` |
| `web/src/lib/harness/agy/` | `draftCarriesSend` |
| `web/src/lib/harness/pi/` | only if a draft is visible |
| `web/src/lib/actions.ts` (or `reply-action.ts` if 12 already shipped) | no-adapter long send fail-closed |
| Adapter tests + `actions.test.ts` | Long Cursor/Agy send verifies or holds |
| `CHANGELOG.md` | Unreleased Fixed |
| README troubleshooting | one line if Codex still cannot verify |

## Tests

- Cursor long draft: `adapter.draftCarriesSend` true on a matching composer extract; false on someone else’s leftover.
- Agy equivalent if it has a composer.
- No-adapter long send: does not return `sent` without a verify; test the status you chose.
- Claude paste path unchanged.

## Done means

A long phone send is verified by a real draft/paste marker on adapters that have a composer, and is not claimed succeeded on Codex without a marker.
