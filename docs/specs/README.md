# Council specs — 2026-09-21 (status as of 2026-09-27, `874b85b`)

Implementable slices for the Sightr council recommendations. **Row 4 is not in this set** (whistlr wizard / multi-select). Marked prompt-select cards already live in [`docs/whistlr-31f-sightr.md`](../whistlr-31f-sightr.md). Do not reopen that path from these files.

One spec = one run. Do not implement a sibling spec in the same run. Numbers match the council table.

| # | File | Sev | Status | One line |
|---|------|-----|--------|----------|
| 01 | [01-blocked-pane-chrome.md](01-blocked-pane-chrome.md) | High | Done — #28 wheel in row, #29 Yes/No gated, tap-to-focus bail + `min-h-11` options | Competing chrome on a blocked pane |
| 02 | [02-ios-composer-keyboard.md](02-ios-composer-keyboard.md) | High | Open | Composer sits under the iOS keyboard |
| 03 | [03-fetch-no-store.md](03-fetch-no-store.md) | High | Open — confirm the Safari 304 on a device first (bridge already sends no-store) | Safari 304 after key / cache |
| 05 | [05-agy-trust-keys.md](05-agy-trust-keys.md) | High | Done — #21 walks the pointer; conformance bans unprinted prompt-select digits | Agy trust Yes/No sends invented digits |
| 06 | [06-prompt-binding-shared.md](06-prompt-binding-shared.md) | High | Open — see the #29 dialog-sniff import note | Two prompt-bind matchers; Claude-only regions |
| 07 | [07-beacon-session.md](07-beacon-session.md) | High | Open | Expired beacon overwrites Herdr session |
| 08 | [08-grok-live-identity.md](08-grok-live-identity.md) | High | Open | Two Grok prompt grammars; WEAK sibling claims |
| 09 | [09-history-paging.md](09-history-paging.md) | High | Partly — #17 dropped the 1.5 s poll; left: unknown cursor, dedupe, lock, ETag | Unknown cursor duplicates turns |
| 10 | [10-pwa-build-swap.md](10-pwa-build-swap.md) | High | Open | `X-Sightr-Build` does not swap the worker |
| 11 | [11-sighter-config-migrate.md](11-sighter-config-migrate.md) | High | Open | Pre-1.0 `.env` is not copied |
| 12 | [12-split-actions.md](12-split-actions.md) | High | Open — counts and citations refreshed in the spec note | `actions.ts` is a collapsed god file |
| 13 | [13-files-containment.md](13-files-containment.md) | Med | Open — add `bridge/operator-file.ts` | Files tab borrows journal FS; ADR 0026 stale |
| 14 | [14-find-follow.md](14-find-follow.md) | Med | Open | Find close / shell Find freeze |
| 15 | [15-thinking-duration.md](15-thinking-duration.md) | Med | Open | Thought-for uses the next turn's gap |
| 16 | [16-cursor-tool-complete.md](16-cursor-tool-complete.md) | Med | Partly — #21 `SettledRow`; left: last-row Cursor tool on an idle pane | Cursor tools look stuck running |
| 17 | [17-agy-journal-claim.md](17-agy-journal-claim.md) | Med | Done — README line fixed 27 Sep | README claims an AGY session log |
| 18 | [18-cursor-autocomplete-bind.md](18-cursor-autocomplete-bind.md) | Med | Open — the sweep is in `composer-send.ts` | Autocomplete send is unbound |
| 19 | [19-paste-boundary.md](19-paste-boundary.md) | Med | Open — name Pi's one-shot path | Long-send verify is Claude/Codex only |
| 20 | [20-collie-identifiers.md](20-collie-identifiers.md) | Med | Partly — #17; left: `COLLIE_*` in ADR bodies, CLAUDE.md citations | ADRs and logs still name Collie |
| 21 | [21-phone-overscroll.md](21-phone-overscroll.md) | Med | Stale reference — Bart's call on pull-to-refresh | Pull reloads the PWA (GitHub #16) |
| 22 | [22-safe-area-top.md](22-safe-area-top.md) | Med | Open | Banner + header both pad the notch |

## Rules for every slice

- Builder writes: the files the spec names, colocated tests, and `CHANGELOG.md` Unreleased when behaviour changes. Docs-only slices (20, parts of 17) skip CHANGELOG unless operator-facing strings change.
- Do not edit `.gitignore`, `.env`, `draftr.toml`, `.github/`. Do not commit `/brand/`.
- Do not add `CONTEXT.md` or `DECISIONS.md`. Do not invent ADRs except where a spec says to update an existing one (13, 20).
- Do not implement row 4. Do not type whistlr decisions into the pane from these slices.
- Root `bun run test` (typecheck + bridge + scripts) must stay green. Web Vitest when the spec touches `web/src`.
- No AI attribution in code, comments, or commit messages.
