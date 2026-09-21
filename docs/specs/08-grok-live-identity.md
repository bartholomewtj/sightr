# 08 — One Grok live-prompt contract

Council row 8. Severity: high. Journal + form.

## Why

Grok’s live composer line is parsed twice:

- `liveGrokPrompt` in `bridge/journal/grok.ts` uses `PROMPT_LINE = /^\s*[>❯]\s+(.+)$/` on **raw** pane text (also used as `opts.hint` for scoring).
- `COMPOSER_PROMPT` / `extractInputDraft` in `web/src/lib/harness/grok/markers.ts` expect a boxed `│ ❯ … │` (or `│ > … │`) inner row on **parsed** line text.

`GrokTranscriptSource.inferFromCwd` WEAK-binds the newest unclaimed primary log at the cwd (`CLAIM_WEAK` in `claims.ts`) whenever the screen has no LIVE/TITLE hit. Claims are written on a history fetch. The first phone-open of a quiet Grok pane with multiple primaries can be handed a sibling’s `chat_history.jsonl`. `free = pool.find(...)` then `claims.set(..., CLAIM_WEAK)` does not check `pool.length === 1`.

jsonl `parse()` is a third grammar and should stay journal-only.

## Do

- Export one “live Grok prompt body” helper that is box-aware and uses the same glyph rules as the web adapter (`❯` / `>` inside the box, trailing clock strip as today). Use it from `liveGrokPrompt` and from `inferFromCwd` hint scoring.
- Leave jsonl `parse()` as the journal-only grammar.
- Emit `CLAIM_WEAK` only when `pool.length === 1`. With multiple primaries, return `null` / no-session until LIVE, TITLE, or `CLAIM_REPORTED` evidence.
- Keep `CLAIM_WEAK < CLAIM_REPORTED` ordering. Do not let WEAK overwrite a stronger claim (already `set` false in tests — keep it).

## Do not

- Change Claude/Pi/Cursor claims.
- Change whistlr (row 4) or prompt-binding (row 06).
- Fold the entire Grok screen adapter into the bridge.

## Files

| File | Change |
|---|---|
| `web/src/lib/harness/grok/markers.ts` | Export the live-body helper (or a shared tiny module both sides can import) |
| `bridge/journal/grok.ts` | `liveGrokPrompt` + WEAK gate |
| `bridge/journal/grok.test.ts` | Box-aware prompt; multi-primary no WEAK |
| `bridge/journal/claims.test.ts` | Only if claim API changes |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- Boxed `│ ❯ query │` dump: `liveGrokPrompt` returns `query` (clock stripped as today).
- Raw `> query` dump still works (phone-width / `pane.read` text).
- Two unclaimed primaries at the same cwd, empty/no LIVE hint: `inferFromCwd` returns null; no `CLAIM_WEAK` write.
- One unclaimed primary: WEAK still binds.
- `CLAIM_REPORTED` / LIVE / TITLE still win over WEAK.

## Done means

Two Grok tabs in one space no longer show each other’s threads just because one quiet pane opened first. A composer-paint change updates session claims and chrome together.
