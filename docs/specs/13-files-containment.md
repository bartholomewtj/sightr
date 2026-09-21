# 13 — Files-tab containment module

Council row 13. Severity: medium. Form + fork.

## Why

`bridge/journal/files.ts` still claims journals are the only filesystem reader and owns `containedRealpath`. `bridge/workdir.ts` (ADR 0026’s second reader) imports that helper and already implements `/api/files/save` and `/api/files/delete`. ADR 0026 still says the module is read-only and names `COLLIE_WORK_ROOT`. `journal/files.ts` header (“Reading session logs is the only thing in the bridge that touches the filesystem”) fights both ADR 0026 and the save/delete routes.

## Do

- Lift `containedRealpath` / `containedRealpathIn` (and the “absent ≡ refused” rule) out of `journal/` into a small containment module both `journal/*` and `workdir.ts` / `workdir-zip.ts` / `workdir-git.ts` import.
- Treat `workdir.ts` as the Files-tab module whose writes are part of its job — not a journal leftover. Journal adapters stay “parse this harness’s log”.
- Update ADR 0026 in place: `SIGHTR_WORK_ROOT`; listings/previews/downloads **and** save/delete; containment helper lives outside `journal/`. Do not pretend it is still read-only. If the project rule is “ask before every ADR add”, this is an **edit of an accepted ADR whose code already moved** — keep the number, add a short “Amended 2026-09-21” note at the top rather than a new ADR, unless the owner prefers 0028. Do not add 0028 in this slice without asking.
- Keep unique-origin HTML open (ADR 0027) unchanged.

## Do not

- Widen `SIGHTR_WORK_ROOT` or change caps/refusal list.
- Move journal log parsers.
- Rewrite every Collie env name in other ADRs (row 20).

## Files

| File | Change |
|---|---|
| `bridge/containment.ts` (new, name as you like) | `containedRealpath*` |
| `bridge/journal/files.ts` | Re-export or import; drop “only filesystem reader” |
| `bridge/workdir.ts`, `workdir-zip.ts`, `workdir-git.ts` | Import the new module |
| `docs/adr/0026-the-files-tab-is-the-second-filesystem-reader.md` | SIGHTR_WORK_ROOT; writes in scope |
| Existing workdir / journal file tests | Import paths |
| `CHANGELOG.md` | skip unless operator-facing |

## Tests

- Existing containment tests still pass (symlink out, absent ≡ refused).
- `journal/files.ts` no longer claims exclusivity in a way tests or comments assert.
- Save/delete routes still refuse paths outside the root.

## Done means

Journal adapters stay “parse this harness’s log”. Files-tab containment and mutability live in one place. ADR 0026 matches the save/delete routes.
