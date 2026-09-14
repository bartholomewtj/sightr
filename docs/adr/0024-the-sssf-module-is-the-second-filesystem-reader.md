# 0024 — The SSSF traces module is the second sanctioned filesystem reader, and it runs code Collie does not own

Status: **Accepted** (2026-08-18)

## Context

`CLAUDE.md` says the journal (`bridge/journal/`) is the **only** thing in the bridge that touches the
filesystem, and that every path it reads goes through `containedRealpath`. That rule exists because a
socket call can type into a real terminal, so anything that reads agent-written files over the
tailnet has to be held to the same standard.

The SSSF traces tab (`bridge/sssf-viz.ts`) needs three things the journal doesn't do:

- **Discovery.** Herdr's `workspace.list` carries no directory; the module walks up from each pane's
  `cwd` looking for a repo with `adws/adw_data/sssf.db`. Pane cwds are chosen by the agents.
- **A sqlite reader that isn't ours.** The visualiser's `server/db.ts` (in the sssf skill folder,
  named by `SSSF_VIZ_DIR`) is imported into the bridge process, and its Vite config is executed at
  build time. That folder is not in this repo and can be changed by whatever writes to it — a skill
  re-install, or an agent Collie is driving.
- **The prompts endpoint** reads `sessions/<adw>/<agent>/prompts/*.md` — files the ADW agents wrote.

Two shapes were proposed and rejected:

- *Vendor `db.ts` into the bridge.* It is 418 lines that would drift from upstream; the visualiser's
  API is what the trace UI expects, so a copy buys review of one file at the cost of silent
  divergence. And it doesn't remove the trust: the UI bundle Collie serves is built from that same
  folder either way.
- *Iframe the visualiser same-origin.* Then a bug in the visualiser's `v-html` markdown renderer
  (fed by agent-written prompt files) is a typed keystroke into a real terminal.

## Decision

**Allow exactly one more filesystem reader, `bridge/sssf-viz.ts`, on these terms:**

1. **Same containment rule.** Every prompts read goes through `containedRealpath(candidate,
   sessionsDir)` on the real path, is byte-capped, and is off entirely under `COLLIE_TRANSCRIPT=off`.
   Segment names are validated (`.`/`..` and separators refused) before a path is built.
2. **Discovery accepts only a git worktree root** (`.git` present) that holds
   `adws/adw_data/sssf.db` — never an arbitrary ancestor — and never a path the client named. The
   client sends a workspace id; the path stays in the bridge.
3. **The visualiser folder is inside Collie's trusted computing base, and we say so.** `bun install`
   runs `--frozen-lockfile` with a scrubbed environment; the build is a subprocess with the same
   scrubbed environment; a startup contract check refuses to run against a folder that isn't the
   visualiser, whose `db.ts` lacks the members we call, or that lacks the host-mount patches.
4. **The UI is framed with `sandbox="allow-scripts"`** — an opaque origin that cannot call Collie's
   own `/api/*`. Its reads reach `/sssf/api/*` with `Origin: null` plus a per-boot token that only
   Collie's own snapshot hands out; writes never get that pass (archive is off inside the tab).
5. **The whole feature is one file plus one-line hooks.** `server.ts` calls `owns()/handle()` and
   `decorate()`; nothing else in the bridge knows the module exists, and `SSSF_VIZ_DIR` unset means it
   does not run.

## Consequences

- A second module now claims filesystem access; the CLAUDE.md sentence "the journal is the only thing"
  is amended to name this one, and any third claimant should expect the same terms.
- Accepting `Origin: null` anywhere is a deliberate hole with a key. It is scoped to GET routes under
  `/sssf/api/`, keyed by a 48-hex per-boot token, and answered with `Access-Control-Allow-Origin:
  null` only when the token matches. Widening it (a wildcard, a longer-lived token, a write route)
  needs a new ADR.
- Vite is executed against a folder Collie doesn't own on every source change. If that becomes
  unacceptable, the escape is to build outside the bridge process (a ctl step) and serve a static
  dist — the serving half of this module needs no change for that.
- The visualiser's phone/embed patches live in the visualiser, not here. A skill re-install that
  drops them turns the feature off loudly (`[sssf] disabled: …`); re-apply or upstream them.
- Discovery also scans *down* from a pane's cwd (0.34.0), because in practice panes sit in a folder
  of repos and the ADW runs by path. That scan stays filesystem-only and bounded — two levels, 200
  entries per directory, no symlinks or junctions, dot-dirs and dependency folders skipped — and a
  db is opened only at `<worktree root>/adws/adw_data/sssf.db`. The client still never names a
  path: `repo` on the frame URL is a name the bridge assigned, looked up in its own map.
