# Decisions

Chose-X-not-Y. Cap 15 entries / ~40 lines. Ask before adding.
If the code now enforces a row, delete it.

| Date | Chose | Not | Why |
|---|---|---|---|
| 2026-09-27 | The bridge imports the client's dialog detectors directly (`web/src/lib/harness/dialog-sniff.ts`, leaf files only: no `react`, no `@shared`) to report resting Cursor / Antigravity panes as needs you | Move the detector closure into `shared/harness/` first | One source of truth with the phone's own parse, so the bridge and the lifted card can't disagree, and a small diff. Sightr installs as a whole-repo plugin, so `web/src` is always present. The root typecheck runs before the web install in CI, which keeps the closure honest. Revisit if spec 06 moves prompt binding to `shared/`. |
| 2026-09-28 | Type a multi-line reply to Agy as bracketed pastes of at most 1000 chars, each cut between two non-space characters (#47, #53) | Flatten newlines to spaces; refuse multi-line sends to Agy; one paste for the whole reply | Flattening loses code and lists, and refusing blocks a normal reply. Live on Agy 1.2.12, a 4.7 KB single paste folded into `[Pasted text]` and left the screen half drawn, so the guard stalled. Pastes cut at line ends lost their seam newlines (40 rows arrived as 36). Revisit if Agy stops folding or trimming pastes. |
| 2026-09-28 | Herdr actions run `powershell … -File contrib/windows/sightr-ctl.ps1 <verb>` directly (#51, #55) | A compiled launcher (`build/sightr-action-v1.exe`); committing the exe; a manual first start | `herdr plugin link` never runs `[[build]]`, so the launcher was missing on a fresh linked checkout and every action failed. PowerShell is itself a native executable, and the relative `-File` path resolves from the plugin root. That was verified on a fresh clone with no `build/`. It also keeps a binary out of the repo. |
