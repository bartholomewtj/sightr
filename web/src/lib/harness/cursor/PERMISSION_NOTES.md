# Cursor command approval — keystroke recipe

Captured 2026-09-12 on Cursor Agent `v2026.09.10-fd3934a` in pane `wC0:p1`
(`herdr agent start probe-cursor --kind cursor`). Herdr status: `blocked`
(`approval_prompt`).

```
 Run this command?
 Not in allowlist: echo
  → Run (once) (y)
    Add Shell(echo) to allowlist? (tab)
    Run Everything (shift+tab)
    Skip & tell the agent what to do instead (esc or n)

                                                                 ctrl+r to review changed files
```

The trailing `ctrl+r to review changed files` row is optional chrome (dirty-files hint).
It is not an option; the detector skips it. Without that skip the card falls through to
the Yes/No fallback (phone smoke 2026-09-12).

The pointer (`→`) moves with Tab / arrows; it is **not** the key. Live probe with the
pointer on the allowlist row: `y` still ran the command once.

| Key | Effect |
|---|---|
| `y` | Run (once) — one-shot approve |
| `n` | Skip — opens "Tell the agent what to do instead" composer (Esc cancels back to the card) |
| `tab` | Add this shell pattern to the allowlist — **persistent**, never a phone button |
| `shift+tab` | Run Everything — **persistent mode change**, never a phone button |
| `Escape` | Same skip entry as `n` when the card has focus |

The adapter lifts only **Run (once)** → `y` and **Skip** → `n`. Fail closed if either
row is missing, or if an option key other than `y` / `tab` / `shift+tab` / `esc or n`
appears.

Write-file approval (`write to this file?` / `proceed (y)`) exists in Herdr's cursor
manifest but did not appear on this probe (Auto mode wrote a new file without a card).
Do not synthesise that layout.
