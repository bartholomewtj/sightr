# 11 — Migrate pre-1.0 Sighter config

Council row 11. Severity: high. Fork.

## Why

`CHANGELOG.md` 1.0.0 claims config dirs moved with the rename. `migrateLegacyState` in `bridge/state-migrate.ts` only copies a sibling **state** dir (`herdr.sighter` → `herdr.sightr` via `legacyStateDir`). `scripts/ctl/env.ts` `parseEnv` and `bridge/config.ts` never alias `SIGHTER_*`. `scripts/ctl/env-check.ts` prints leftover keys without warning. `scripts/ctl/paths.ts` resolves only `herdr.sightr`. A machine that still has `herdr.sighter/.env` looks unconfigured after the plugin-id change: VAPID, `TRUSTED_USER`, `DEVICE_HEADER`, `PUBLIC_HOSTS` never load.

## Do

- When the new config dir is missing or has no `.env`, and a sibling `herdr.sighter` (or `~/.config/sighter`) `.env` exists, copy it the same way state is copied: nothing deleted, nothing merged into a dir that already has an `.env`.
- On that copy, rewrite keys `SIGHTER_*` → `SIGHTR_*` (prefix only; do not invent values). Leave unknown keys as-is with a warning.
- Do **not** alias `SIGHTER_*` at runtime in `parseEnv` / `loadConfig` — one write of the new names, then only `SIGHTR_*` is read.
- `env-check`: if any key starts with `SIGHTER_`, warn (or fail) naming the rewrite.
- Log one line when a config copy happens, like state: `config: copied pre-1.0 Sighter env from …`.

## Do not

- Alias old names forever.
- Copy `commands.toml` / `keys.toml` unless they are the only copies and the new dir is empty — prefer `.env` first; if you copy the whole empty-target dir, match state-migrate’s “empty directory” rule.
- Touch live `.env` in the operator’s running config from tests (temp dirs only).
- Rewrite Collie ADRs (row 20) in this slice.

## Files

| File | Change |
|---|---|
| `bridge/state-migrate.ts` or `scripts/ctl/` new helper | Config-dir copy + key rewrite |
| `bridge/index.ts` or `scripts/ctl/env.ts` | Call once at start / before load |
| `scripts/ctl/env-check.ts` | Warn on `SIGHTER_*` |
| `bridge/state-migrate.test.ts` / env tests | Empty dest copies; non-empty dest leaves; prefix rewrite |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- Empty `herdr.sightr` config + sibling `herdr.sighter/.env` with `SIGHTER_TRUSTED_USER` → new file has `SIGHTR_TRUSTED_USER`, old file untouched.
- Dest already has `.env` → no copy, no overwrite.
- `env-check` on a file that still contains `SIGHTER_PORT` prints a warning.
- `parseEnv` still does not treat `SIGHTER_PORT` as `SIGHTR_PORT`.

## Done means

A pre-1.0 `.env` actually applies after the plugin-id change instead of looking configured while the bridge reads none of it.
