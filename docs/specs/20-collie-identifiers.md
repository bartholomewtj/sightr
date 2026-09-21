# 20 — Live identifiers in ADRs and logs

Council row 20. Severity: medium. Fork + form.

## Why

Fork ADRs still prescribe dead Collie identifiers as current fact:

- `docs/adr/0023-host-validation-is-fail-closed.md` — `COLLIE_PUBLIC_HOSTS`, `scripts/collie-ctl.sh`
- `docs/adr/0025-a-major-upgrade-is-consented-by-flag.md` — `herdr.collie`, `collie-ctl.sh`, `bartholomewtj/collie`, `COLLIE_UPDATE_REF`, `scripts/check-version.sh`
- `docs/adr/0026-…` — `COLLIE_WORK_ROOT` (row 13 may already have amended 0026; if so, skip that file here)
- `docs/adr/0019-…` — `COLLIE_UPDATE_REF`
- `docs/adr/README.md` line 91 — `bartholomewtj/collie`; lines 86–91 reserve 0011–0016 for Collie’s `v1` pack/federation merge; 0024 unexplained

`docs/HERDR_API.md` still says Collie and `COLLIE_POLL_MS` / `COLLIE_POLL_IDLE_MS`. It links `ARCHITECTURE.md`, which does not exist. Comments in `web/src/lib/markdown.ts`, `web/src/lib/links.ts`, `web/src/components/markdown-text.tsx` cite `CLAUDE.md` §“Security posture”, which does not exist.

Windows-only launch still tells operators to use Unix: `scripts/push-test.ts` and `bridge/responses.ts` `failureText` print `journalctl --user -u sightr`. `bridge/server.ts` refers to a hand-maintained `systemd/sightr.service`. `bridge/config.ts` mentions “the launchd plist”. None of those units exist (`herdr-plugin.toml` is Task Scheduler + `sightr-ctl.ps1`).

Inherited ADRs 0001–0010 may keep “Collie” in **historical** Context. Decision/consequences that operators still follow must use `SIGHTR_*` / `herdr.sightr`.

## Do

- Rewrite fork-ADR **commands, env names, script paths, and the README index line** to 1.0 identifiers. Add one mapping note on inherited 0001–0010 rather than pretending Collie is still the product.
- Drop the reserved-for-upstream-v1 claim. State that 0011–0016 (and 0024) are unused on this product, and that the next ADR is 0028 on this repo only.
- Replace `COLLIE_POLL_*` in `HERDR_API.md` with `SIGHTR_POLL_*`. Point Architecture links at README Architecture / `docs/archify/`, not a missing `ARCHITECTURE.md`.
- Point markdown/XSS comments at README Security (or a short in-repo sentence), not missing `CLAUDE.md`.
- Replace journalctl / systemd / launchd strings with `sightr-ctl.ps1 logs` / Task Scheduler `herdr.sightr`.

## Do not

- Rename plugin id or env vars in code (already `SIGHTR_*`).
- Implement config migrate (row 11) or Files ADR substance (row 13) beyond identifier strings if 13 has not run — if 13 already rewrote 0026, do not fight it.
- Delete superseded ADR 0020; leave it superseded.
- Track collie. Do not add a merge plan for 0011–0016.

## Files

| File | Change |
|---|---|
| `docs/adr/0019`, `0023`, `0025`, `0026` (if still Collie), `0001` operator-facing env names | SIGHTR_* / herdr.sightr |
| `docs/adr/README.md` | Index; unused numbers; next is 0028 |
| `docs/HERDR_API.md` | Poll env; architecture pointer |
| `web/src/lib/markdown.ts`, `links.ts`, `markdown-text.tsx` | Citation |
| `scripts/push-test.ts`, `bridge/responses.ts`, `bridge/server.ts`, `bridge/config.ts` | Logs / supervisor names |
| `CHANGELOG.md` | skip (docs) unless push-test user string counts |

## Tests

- grep (case-sensitive env): no `COLLIE_POLL_`, `COLLIE_PUBLIC_HOSTS`, `COLLIE_WORK_ROOT`, `COLLIE_UPDATE_REF` in `docs/` except historical Context that is clearly past-tense, or this spec’s mapping note.
- `journalctl` does not appear in operator-facing strings (`push-test.ts`, `responses.ts`).
- `bun test` still green (string asserts in ctl tests).

## Done means

An agent following Host/update/Files ADRs sets `SIGHTR_*` / `herdr.sightr`. A failed push points at config-dir logs that exist. Future ADRs do not wait on a Collie branch this fork does not merge.
