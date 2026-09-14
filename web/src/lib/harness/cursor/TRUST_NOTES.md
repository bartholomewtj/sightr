# Cursor workspace trust — keystroke recipe

Captured 2026-09-12 on first launch of Cursor Agent in an untrusted cwd
(`C:\Users\alice\Projects\my-plugin`, pane `wC0:p1`). Herdr status: idle fallback
(the trust card is not in cursor.toml yet).

```
  ⚠ Workspace Trust Required
  …
  Do you trust the contents of this directory?
    C:\…
   ▶ [a] Trust this workspace
     [q] Quit
  Use arrow keys to navigate, Enter to select, or press the key shown
```

| Key | Effect |
|---|---|
| `a` | Trust this workspace (also Enter while highlighted) |
| `q` | Quit the agent |

The adapter lifts both as `prompt-select` / family `trust`. Require the
"Workspace Trust Required" title so a random `[a]`/`[q]` list cannot lift.
