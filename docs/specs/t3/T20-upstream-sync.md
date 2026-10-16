# T20 — The upstream check covers contracts, answers in JSON, and remembers decisions

Status: draft (T3-shape series). Depends on: T09 (`scripts/t3-upstream.ts`, `web2/t3-upstream.json`), T01
(`shared/v2/contracts.ts`). Plan: [`docs/T3_ADAPTATION.md`](../../T3_ADAPTATION.md).

## Problem

`scripts/t3-upstream.ts` tracks only the files listed in `web2/t3-upstream.json`, and every `local`
path is under `web2/`. It cannot see the layer that matters most:

- `shared/v2/contracts.ts` mirrors T3's `packages/contracts/src/orchestrationV2.ts`.
- `shared/v2/request-question.ts` mirrors `OrchestrationV2UserInputQuestion`.

When T3 adds a turn-item type or renames a field, nothing reports it. The first sign is a ported
component that no longer type-checks.

The weekly routine and `/t3-sync` also need two things the checker lacks. They need machine-readable
output, so they don't parse prose. And they need a record of changes Bart chose to skip, so a skipped
change is not raised again every week.

## Change

- **`web2/t3-upstream.json`**
  - **New mode `shape`.** The Sightr file mirrors type and field names, not the body. Add two rows:
    - `{local: "../shared/v2/contracts.ts", upstream: "packages/contracts/src/orchestrationV2.ts", mode: "shape", commit: "e3b35d1b…"}`
    - `{local: "../shared/v2/request-question.ts", upstream: "packages/contracts/src/orchestrationV2.ts", mode: "shape", commit: "e3b35d1b…", note: "OrchestrationV2UserInputQuestion"}`
  - **`local` paths stay relative to `web2/`.** `../` reaches `shared/`. The checker refuses a path that resolves outside the repo (`isInside`).
  - **New top-level `decisions` array.** Each row is `{upstream, commit, verdict: "skip" | "defer", reason, date}`, where `commit` is the upstream commit the decision was made against.
- **`scripts/t3-upstream.ts`**
  - **`shape` rows** get the same `unchanged | changed | removed` status. A changed `shape` row also prints the names of the exported `Schema.Literal("…")` type tags and `Schema.Struct` keys that were added or removed between the two commits (a line diff of the matching lines is enough; no TypeScript parser). That list is what a contract port starts from.
  - **`--json`** prints one object and nothing else:
    ```
    { ref: {name, sha}, baseline,
      rows: [{local, upstream, mode, commit, status, decided?}],
      newFiles: [{path, decided?}],
      contracts: [{local, added: string[], removed: string[]}] }
    ```
    `decided` is the matching `decisions` row when one exists for that upstream path at or after the row's `commit`.
  - **Text output** marks decided changes `(decided: skip — <reason>)`, and its summary counts only undecided ones.
  - **Default ref is `main`, not the newest tag.** The ledger records T3 `main` commits. T3's tags are behind `main` or branch off it, so today's default (newest tag) reports changes backwards: `v0.1.0` is 78 commits behind the `e3b35d1b` baseline.
  - **A ref the baseline is not an ancestor of is refused** with exit 1 and the reason (`git merge-base --is-ancestor baseline ref`).
  - **Exit code** stays 0 for every report. A broken manifest or failed clone exits 1 with the reason; the routine reports that as an error, not as "no changes".
- **`docs/specs/t3/README.md`**: add a T20 row to the slice table.

## Invariants

- The checker never edits the repo or the manifest. It still only reads and reports.
- No row is reported `changed` against a `commit` the cache does not hold. That case stays `unknown-commit`, as today.
- A `decisions` row hides only the exact upstream path it names, and only up to its own commit. A later upstream change to the same file is reported again.

## Tests (`scripts/t3-upstream.test.ts`, local fixture git repo, no network)

- A `shape` row outside `web2/` resolves and reports `changed` when the fixture's contract file changes. A `local` that resolves outside the repo is refused.
- The changed-contract report lists an added `Schema.Literal("new_item")` tag and a removed struct key.
- `--json` output parses and matches the documented shape. Text output and `--json` agree on statuses.
- A `decisions` row hides a changed row at its commit. A later upstream commit to that file shows it again.
- With no `--ref` the checker compares against `main`. A ref behind the baseline (a fixture tag on an older commit) exits 1 and names the problem.
- A malformed manifest exits 1. A clean report exits 0 with "no undecided changes".
