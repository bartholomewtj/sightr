# 0025 — A major upgrade is consented by flag; routine update stays inside the installed major

Status: **Accepted** (2026-08-21)

Related: [ADR 0006](./0006-update-advances-the-checkout-herdr-installed.md) and
[ADR 0019](./0019-update-pins-to-the-newest-release-tag.md) — extended, not superseded.
`update` still advances the checkout in place, and a managed checkout still pins to a **release tag**,
never origin HEAD. Only the **which tag** question, and the gate in front of it, change here.

Upstream's equivalent is their ADR 0020. This fork already used 0020 for subscribe, so this is 0025.

## Context

ADR 0019 made `update` pin a Herdr-managed checkout to the newest `vX.Y.Z` tag instead of origin
HEAD. That closed the "unreleased main" hole. It left a different one: the newest tag of **any**
major. Tag `v1.0.0` on this repo, and every 0.x install's next routine update crosses a major
without being asked. `CLAUDE.md` defines MAJOR as *"the operator must change something"*. A silent
major is a contradiction: the release says "you must act", and the mechanism gives no moment to act.

The in-app banner already reads this fork's tags (`bartholomewtj/collie`) over anonymous HTTPS. The
verb that acts on that banner has to apply the same split, or the operator taps update, it
succeeds, and the banner is still there.

A Herdr plugin action has **no TTY**, and the phone banner has no terminal. An interactive confirm
would make the crossing unreachable from the surface that announces it.

## Decision

**Routine `update` stays inside the installed major. Crossing a major is a separate, explicitly
flagged act.**

1. **The installed major is read from `herdr-plugin.toml`.** Same file Herdr reads and
   `scripts/check-version.sh` gates on.
2. **A managed checkout resolves the newest strict `vX.Y.Z` tag inside that major** (ADR 0019's
   grammar, narrowed). `--major` resolves the newest tag of the **next** major, one crossing at a
   time. `COLLIE_UPDATE_REF` still overrides both — it is the existing incident-pin hatch and is
   itself the consent.
3. **A linked clone keeps its branch and `git pull --ff-only`.** Its gate is a pre-flight: fetch,
   read the manifest at `@{u}` (the commit the pull will actually take, not the remote's default
   branch), refuse before pulling if that commit's major is higher.
4. **The flag is the consent. There is no prompt.** Wired as
   `herdr plugin action invoke update-major --plugin herdr.collie` (`collie-ctl.sh update --major`).
5. **Never origin HEAD.** An install that cannot name its major falls back to the newest release
   tag (ADR 0019), loudly, not to the default-branch tip.

## Consequences

- **0.x stays 0.x** until someone runs `update-major`. Tagging `v1.0.0` on this fork no longer
  auto-delivers itself to every phone.
- **The banner has two answers.** `latest` is the newest release of the running major;
  `majorAvailable` is a higher major, named apart, with the consent command.
- **An install that never takes this release is not protected.** Same adoption-window shape as
  ADR 0006 / 0019.
