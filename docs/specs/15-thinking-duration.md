# 15 — Thinking duration is think time, not inter-turn idle

Council row 15. Severity: medium. Journal.

## Why

`thinkingDuration` in `web/src/lib/transcript-fold.ts` is the timestamp gap to the **next** journal entry. Null when there is no next entry — the UI then says live “Thinking” (`ThinkingPart` when `seconds === null`). Claude/Pi put `thinking` on the **same** assistant row as the reply. The last turn therefore stays live “Thinking”, and a user message hours later becomes “Thought for 1440m”.

Tests in `transcript-fold.test.ts` currently encode the gap-to-next-entry model. Change the tests with the contract.

## Do

- Treat thinking as finished when the same entry already has speech or tools.
- Only use a following entry’s timestamp when thinking is its own row (no speech/tools on that entry).
- Cap or omit a duration that is clearly inter-turn idle (e.g. gap > a few minutes, or next entry is `role: user`). Prefer omit over a lying “Thought for 1440m”.
- Last turn with speech/tools on the same row: collapsed “Thought for Ns” if you have a duration from the harness, else no pulse. Do not pulse “Thinking” on a completed reply.

## Do not

- Change tool-run folding labels except where they share `thinkingDuration`.
- Invent thinking text from the model; this is timestamps + parts only.
- Change Cursor tool completion (row 16) except if `ToolPart` “running” shares the same “no next row” bug — Cursor tools are a different slice.

## Files

| File | Change |
|---|---|
| `web/src/lib/transcript-fold.ts` | `thinkingDuration` |
| `web/src/lib/transcript-fold.test.ts` | Same-row finished; user-next omitted; last completed turn |
| `web/src/components/transcript-view.tsx` | Only if the “Thinking” vs “Thought for” branch needs the new null meaning |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- Same entry: thinking + text → duration is not the gap to the next user turn; not live Thinking.
- Thinking-only row then assistant speech → duration is the gap to that speech row.
- Thinking-only last row → still live Thinking (null).
- Thinking row then user hours later → no 1440m label (null or capped; pick omit).

## Done means

Collapsed “Thought for Ns” matches think time. A completed last turn no longer pulses as if the model were still thinking.
