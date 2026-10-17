# Adapting T3 Code into Sightr

Sightr v2 (`web2/` + `bridge/threads/`) is shaped after [T3 Code](https://github.com/pingdotgg/t3code)
(MIT). T3 keeps shipping. This is how its new work keeps reaching Sightr, on purpose and in small
steps, without Sightr becoming a fork of it.

T3 is a **reference, not a dependency**. Nothing in Sightr imports T3 or needs it installed. The
checker clones T3 into a cache outside the repo when it runs. The design behind v2 is in
[`specs/t3/README.md`](specs/t3/README.md).

## What we mirror

| Layer | Sightr file(s) | T3 source | Kept aligned by |
|---|---|---|---|
| **Contracts**: turn items, thread fields, questions, keybinding commands | `shared/v2/contracts.ts`, `shared/v2/request-question.ts`, `web2/src/t3/contracts/*` | `packages/contracts/src/orchestrationV2.ts`, `keybindings.ts` | Same `type` names and field names. Sightr-only items (`session`, `screen`) are marked as extensions. |
| **Logic**: pure functions | `web2/src/**/*.logic.ts`, `web2/src/t3/shared/*`, `web2/src/t3/client-runtime/*` | `apps/web/src/**/*.logic.ts`, `packages/shared`, `packages/client-runtime` | Taken verbatim where the shapes allow it. |
| **Components** | `web2/src/components/**` | `apps/web/src/components/**` | Same file names and jobs. Same Tailwind semantic tokens (mapped to `style/tokens.md`). T3 imports we lack go through `web2/src/t3/shims/*`. |
| **Behaviour** that needs the bridge | `bridge/threads/*` commands and ingest | T3 server features | A new T3 feature that needs data or a command we don't have becomes bridge work first. |

`web2/t3-upstream.json` is the ledger: one row per adopted file, `{local, upstream, commit, mode}`.

- `verbatim`: byte-identical to upstream at `commit`.
- `adapted`: upstream body with local edits. The file's first line names the upstream path and commit.
- `pattern`: same job and name, Sightr's own code.

Every adapted or verbatim file is covered by T3's MIT notice in `web2/THIRD_PARTY.md`.

## What we never take

These are not "later" items. Raise one only as a deliberate design change, in `specs/t3/README.md`.

- **Effect**, `@effect/atom-react` and T3's client runtime. Server state is our own event-applying store; T3 code that needs them goes through a shim or is ported as a pattern.
- **Tiptap**. The composer stays a plain text area, so phone dictation works.
- **Electron, Expo, Clerk, T3 Connect relays and pairing.** Sightr is one PWA over Tailscale with its WebAuthn lock.
- **Provider processes owned by the server.** Herdr owns the agents; Sightr observes panes and starts them with `agent.start`.
- **Worktrees, checkpoints, per-turn diffs, rollback, commit/push/PR.** Out of scope for v2 (`specs/t3/README.md` "Not in this series"). Revisit as a series of its own, not as a sync.
- **Branching on a harness id in web2.** Capability flags only; `scripts/web2-harness-ids.ts` fails the build otherwise.
- **Claude's live `/model` and `/effort`.** They rewrite the user's global default. Models are chosen at spawn.

## The loop

```
weekly review ──► one GitHub issue ──► /t3-sync confirm ──► sync slice spec (PR) ──► build (one run) ──► release
 (cloud, Opus)    review + recs         gate on the PC       docs/specs/t3/Tnn         ledger bumped
```

1. **Review (weekly, automatic, cloud credits).** Each Monday at 8:00 Brisbane the cloud routine "sightr t3-sync weekly review" (Opus) runs
   `bun scripts/t3-upstream.ts --ref main` on Sightr's `main`, then reviews every change against this document. It also diffs T3's `orchestrationV2.ts` until T20 lands.
   - **Why `main`.** The ledger records commits from T3's `main`. T3's stable tags are behind it (`v0.1.0` is 78 commits older than the baseline `e3b35d1b`), and its preview and nightly tags branch off it. A tag would report changes backwards.
   - **Guard.** The routine checks that the ledger `baseline` is an ancestor of the sha it compares against.
   - **Output.** When anything changed, it opens a GitHub issue on `bartholomewtj/sightr` labelled `t3-sync` and titled `T3 review: main @ <sha7> (<N> changes, <K> recommended)`. The issue is the full review, so `/t3-sync` starts from it instead of redoing the work:
     - a summary and the top 3–7 recommendations, contracts first, each with effort, risk and files;
     - proposed sync slices with the next free `Tnn` numbers;
     - the contract impact on `shared/v2/contracts.ts` and the bridge;
     - per-bucket tables: every item with a verdict (take now, defer, skip), effort and a reason;
     - the ledger `decisions` rows to record;
     - risks and watch items.

     It keeps the body under GitHub's limit and puts long tables in follow-up comments.
   - **One open issue at a time.** A later week comments on the open issue and moves its title to the new sha.
   - **Quiet weeks** produce nothing. The routine never edits the repo, and sends a phone push when it files an issue or fails to.
   - **GitHub access.** No token is needed. Cloud sessions reach GitHub through Anthropic's proxy, using the connected GitHub account (`GH_TOKEN` reads `proxy-injected`). The proxy blocks GraphQL, so `gh issue` and `gh label` fail; the routine uses REST through `gh api` (`repos/bartholomewtj/sightr/issues`, `/comments`, `/labels`).
2. **Confirm (`/t3-sync`, on the PC).** The ClaudeOS skill reads the open `t3-sync` review and spot-checks its verdicts against the code. Where no review exists, it runs the checker itself with `--diff` and does the triage. The buckets both use:

   | Bucket | Meaning | Default action |
   |---|---|---|
   | contract | A turn item, thread field or keybinding command changed upstream | Port first; it decides what the UI can take |
   | verbatim refresh | A `verbatim` row changed and our copy is untouched | Copy, re-run its tests |
   | adapted port | An `adapted` row changed | Re-apply our edits on the new upstream body |
   | pattern review | A `pattern` row changed | Read the diff; port the behaviour if it fits |
   | new feature | A new upstream file, or a change that needs bridge data | Decide adopt, defer or skip, with a reason |
   | skip | Outside "What we never take", or not worth the cost | Record it in the ledger's `decisions` |

   It writes a dated report to the skill's `log/`, noting where it disagrees with the cloud review, and asks Bart which recommendations to take now.
3. **Spec.** For the accepted buckets, `/t3-sync` drafts one sync slice, `docs/specs/t3/Tnn-sync-<sha7>.md`,
   in the series' house style: Problem, Change (named files), Invariants, Tests. It also adds a row to the
   series table and opens a docs PR. A batch that needs both bridge and web2 work becomes two slices,
   bridge first.
4. **Build.** One spec per run, under the series' builder rules:
   - Contracts first, then logic, then components.
   - Tests ported with the file where T3 has them.
   - Root, `web` and `web2` suites green, and the web2 harness-id lint clean.
   - A live check in a scratch herdr workspace for anything a user can see.

   The same commit bumps each ported row's `commit` in the ledger and records every skip in `decisions`.
5. **Release.** Sync slices go out under Unreleased in `CHANGELOG.md` like any other change. The issue
   closes with the PR.

## Porting rules

- **One upstream commit per sync.** Every row ported in a slice moves to the same T3 `main` commit, and the ledger `baseline` moves with the last full sync.
- **Verbatim stays verbatim.** If a verbatim file needs any local edit, demote the row to `adapted` and add the header line. Don't edit it silently.
- **Seams over edits.** When an upstream file grows a new import we lack, add or extend a shim in `web2/src/t3/shims/` before editing the body.
- **Contracts are additive.** Add T3's new fields and item types to `shared/v2/contracts.ts`, and the bridge fills them when it can. Never rename a Sightr field away from T3's name. When T3 renames, follow it, and migrate the event store if stored payloads carry the old name.
- **Sightr's look wins.** Ported class names keep T3's semantic tokens; the colours stay ClaudeOS's.
- **Phone first stays.** A desktop-only T3 interaction needs a phone path (sheet, tap or swipe) in the same slice, or the slice says why not.
- **Record the no's.** A skipped change is a `decisions` row (`{upstream, commit, verdict: "skip" | "defer", reason}`), so the next check does not raise it again.

## Gaps to close first

- **[T20](specs/t3/T20-upstream-sync.md):** the checker learns the contract layer (rows outside `web2/`), `--json` output for the routine, and the `decisions` ledger. Until then, contract drift shows up only in the components that break.
- **CI:** add `web2/` install, typecheck, test and build to `.github/workflows/ci.yml` next to `web`. A sync slice must not land on a CI that never builds web2.

## Where things are

| What | Where |
|---|---|
| Design of v2 and the series | `docs/specs/t3/README.md` |
| Ledger | `web2/t3-upstream.json` |
| Checker | `bun scripts/t3-upstream.ts --ref main [--diff]` (cache `%LOCALAPPDATA%\sightr\t3-upstream`) |
| Shims | `web2/src/t3/shims/` |
| Licence notice | `web2/THIRD_PARTY.md` |
| Triage skill | ClaudeOS `config\skills\t3-sync` (`/t3-sync`) |
| Weekly review | Claude scheduled routine "sightr t3-sync weekly review" (Opus, cloud credits; `trig_01WWDrDv1S5JrxK1C2VULVt9`, Mondays 8:00 Brisbane; claude.ai/code/routines) |
| Queue | GitHub issues labelled `t3-sync` |
