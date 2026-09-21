# 16 — Cursor journal tools are complete

Council row 16. Severity: medium. Journal.

## Why

`bridge/journal/cursor.ts` documents: JSONL has `tool_use` only; tool results are not persisted. `parseCursorTranscript` never attaches `tool.result`. `ToolPart` / `ToolFold` treat a missing result as in-flight (`animate-pulse` “running”, expand disabled). Every Cursor tool run on the phone looks stuck.

## Do

- When the Cursor adapter emits a tool, mark it complete with no body (or `result: { text: "", truncated: true }` — pick one and use it everywhere).
- Do not paint “running” unless a later row can actually supply a result.
- Keep expand-disabled if there is no body; that is not the same as “running”.
- Header comment in `cursor.ts` should match the new contract.

## Do not

- Invent tool output the jsonl does not contain.
- Change Claude/Pi/Grok tool folding (they do get results).
- Change thinking duration (row 15).

## Files

| File | Change |
|---|---|
| `bridge/journal/cursor.ts` | Attach empty/truncated result (or a `complete: true` the UI already understands) |
| `web/src/lib/transcript-fold.ts` / tool view | If the flag lives on the web model |
| Cursor journal tests + transcript-view tests | Cursor tool is not `animate-pulse` |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- A Cursor `tool_use` row without a result: fold is a closed tool line; no “running” pulse.
- Claude/Pi tool with missing result still runs (if their jsonl can be in-flight).
- Expand with empty body: no crash.

## Done means

Cursor journal folds like the other harnesses: one closed tool line you can open, not a perpetual spinner.
