# 17 — AGY is dump-only until it has a journal

Council row 17. Severity: medium. Journal.

## Why

`shared/agents.ts`: `agy` has no `journal` spec. `buildJournalRegistry` has no `agy` adapter. `config.test.ts` pins `journalRoots.agy` undefined. README still says the bridge reads each listed harness’s session log for chat (Claude, pi, Grok Build, Antigravity CLI, Cursor CLI).

This slice does **not** invent an Antigravity jsonl format. Prefer honesty over a speculative reader.

## Do

- Drop AGY from the README “session log for chat” claim. Name the harnesses that actually have journal adapters: Claude, pi, Grok, Cursor.
- In the pane, when the agent is `agy` and there is no session/journal, keep dump-only chat explicit (existing “no session log → live terminal” behaviour). If the empty chat currently looks like a loading journal, show dump-only — do not spin “loading history”.
- If, while doing this, you find an in-repo fixture or note that already documents an AGY session-log path and format, you **may** add a reader in this slice. If you do not find one, do not add `SIGHTR_AGY_ROOT` or an empty adapter.

## Do not

- Guess a log directory.
- Change Agy screen parsers (row 05).
- Claim “coming soon” in the README.

## Files

| File | Change |
|---|---|
| `README.md` | Harness list vs journal list |
| Pane empty-history UI only if AGY currently looks broken | Dump-only |
| `CHANGELOG.md` | Unreleased Fixed/Changed if operator-facing |

## Tests

- `journalRoots.agy` remains undefined unless you found a real format and added a reader (then tests for that reader).
- README does not list Antigravity as a session-log harness.

## Done means

AGY panes stop advertising a journal they cannot serve. Dump-only chat is the explicit behaviour.
