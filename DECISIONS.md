# Decisions

Chose-X-not-Y. Cap 15 entries / ~40 lines. Ask before adding.
If the code now enforces a row, delete it.

| Date | Chose | Not | Why |
|---|---|---|---|
| 2026-09-27 | The bridge imports the client's dialog detectors directly (`web/src/lib/harness/dialog-sniff.ts`, leaf files only: no `react`, no `@shared`) to report resting Cursor / Antigravity panes as needs you | Move the detector closure into `shared/harness/` first | One source of truth with the phone's own parse, so the bridge and the lifted card can't disagree, and a small diff. Sightr installs as a whole-repo plugin, so `web/src` is always present. The root typecheck runs before the web install in CI, which keeps the closure honest. Revisit if spec 06 moves prompt binding to `shared/`. |
