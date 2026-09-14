# 0019 — Update pins to the newest release tag

Status: **Accepted** (2026-08-17)

## Context

`bridge/update.ts` determines when a new release is available by reading `vX.Y.Z` tags via the GitHub API
(`SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/`). When a release is found, the in-app banner advertises that
version and directs the operator to update.

Previously, `scripts/collie-ctl.sh update` (and its PowerShell mirror `contrib/windows/collie-ctl.ps1`)
handled Herdr-managed checkouts by fetching `origin HEAD` and checking out `FETCH_HEAD`. This created
three serious defects:

1. **`update` delivered unreleased `main` tip instead of a release.** `origin HEAD` tracks the default
   branch tip, which includes unreleased development commits pushed moments prior. The script then `exec`s
   the freshly-fetched copy of itself, which runs `bun install` and `bun run typecheck`. Any actor with
   commit access to the default branch (or able to impersonate origin) gained immediate arbitrary code
   execution on the operator's host.
2. **The advertised artefact contradicted the delivered artefact.** The banner reported "Collie X.Y.Z
   available", but updating installed unreleased branch commits that could differ significantly from that tag.
3. **`bun install` was unpinned on the update path.** Bare `bun install` calls in `cmd_build` could resolve
   dependencies differently than the release intended.

## Decision

**`update` on a Herdr-managed checkout pins strictly to the newest `vX.Y.Z` release tag on the remote.**

- **Tag discovery via `git ls-remote`**: Refs are queried without downloading full objects, keeping shallow
  checkouts shallow and cheap.
- **Strict SemVer grammar alignment**: The discovery filter enforces `^v[0-9]+\.[0-9]+\.[0-9]+$`, exactly
  matching `bridge/update.ts:24` (no prereleases, no arbitrary strings).
- **Numeric version sorting**: Versions are sorted newest-first using git's `--sort=-v:refname` (with a
  portable numeric `sort -t. -k1,1n -k2,2n -k3,3n` fallback for older git versions), ensuring `v0.100.1`
  correctly outranks `v0.9.0`.
- **Refusal on absent tags**: If origin contains zero matching release tags, `update` **refuses** with a
  non-zero exit status, prints an actionable diagnostic naming `COLLIE_UPDATE_REF`, and leaves `HEAD`
  completely unmoved. It never falls back to `origin HEAD`.
- **`COLLIE_UPDATE_REF` escape hatch**: An explicit ref or tag override can be supplied via environment
  variable for rollbacks, incident pinning, or untagged fork environments.
- **Verification on landing**: After checkout, the script asserts `git describe --tags --exact-match`
  equals the target tag before proceeding to build.
- **Frozen lockfiles**: Both `cmd_build` bun installs pass `--frozen-lockfile`.
- **Linked clones keep `git pull --ff-only`**: Checking out a tag in a linked clone detaches the developer's
  working branch; linked clones remain on their branch tracking their chosen remote.

## Consequences

### Why signature verification is deferred

GitHub issue #6 suggested `git verify-tag` on fetched tags. We deliberately defer signature verification
because it cannot currently succeed:

- Upstream release tags are annotated but **unsigned** (e.g. `git tag -v v0.29.0` yields `error: no signature found`).
- There is no key material, GPG keyring, SSH `allowed_signers`, or commit/tag signing configuration in the repository.
- Neither GitHub Actions workflow imports signing keys or produces signatures/attestations.
- Enforcing `git verify-tag` today would fail 100% of updates and brick self-update for every user.
- In a fork PR, creating our own key verifies only that the fork signed the tag, providing false security.

Signature verification should be revisited when upstream begins publishing signed release tags or CI integrates
`actions/attest-build-provenance` or `cosign`.

### Other operational consequences

- **`update` no longer delivers unreleased `main`.** Maintainers testing unreleased tip must use a linked
  clone or pass `COLLIE_UPDATE_REF=main`.
- **Untagged repositories cannot self-update without `COLLIE_UPDATE_REF`.** Consistent with the banner, which
  never advertises updates when no release tags exist.
- **ADR 0006's `--force` rationale is weakened but preserved.** With `--frozen-lockfile`, `bun install`
  cannot dirty `bun.lock`. `--force` is retained as defence in depth against other untracked workspace dirt.
