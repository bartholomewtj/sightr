# 01 — Blocked-pane competing chrome

Council row 1. Severity: high. Phone + parser.

## Why

A blocked agent is a 10-second tap. Today three extra input paths steal that tap:

1. `showYesNo` in `web/src/hooks/use-composer-state.ts` is `agentBlocked && !dialogPresent && !isShell && !locked && !direct.active && !sending`. A blocked Cursor/Grok/Agy/Pi pane whose card did not lift still gets Yes/No that `sendWord("yes"|"no")` through `sendGuardedReply` (composer.tsx). Cursor `cursor--permission-skip-feedback.txt` is a live composer left out of `DIALOG`; an unlifted ask still owns `s`.
2. `GestureWheel` is `absolute right-0 -top-10 z-30` on the growing textarea wrapper (`composer.tsx`). It sits on `YesNoStrip`'s No (`h-11` + `pb-2`) and on the last `OptionButton` row. A sub-180ms tap opens Keys (`onTap`); a 180ms hold (`HOLD_MS` in `web/src/lib/wheel.ts`) can fire the shipped Enter slice into the blocked dialog.
3. Defaults are `tapToFocus: true` (`use-display-prefs.ts`). `focusFromMirror` (`use-pane-view.ts`) bails only on `button, a, input, textarea, select, [role='textbox']`. Dump text and `PromptPanel` caption/padding (`role="group"`) count as "start typing". `optionSurface` is `py-1.5` (~35px) while Yes/No and header controls use `min-h-11`.

## Do

- Show the Yes/No strip only when there is **no harness adapter** (today’s Codex / unknown path). If `adapterFor(agent)` exists, and `composerReady` is false **or** `askCardPresent` / `checkboxAskPresent` / any lifted dialog is true, do not show Yes/No and do not force-type the words yes/no.
- Park the gesture-wheel handle beside Send (or hide it while `showYesNo` or `dialogPresent`). It must not paint into the strip or the option list. Keep `preventDefault` only on a handle that does not cover those targets.
- On phone, skip `focusFromMirror` while `dialogPresent` or `agent.status === "blocked"`. Extend the closest() bail to `[role=group]` / prompt chrome.
- Give `optionSurface` `min-h-11` (44px). Keep existing tone/border classes.

## Do not

- Change whistlr / decision-reply (row 4).
- Change desktop Composer vs Direct except where phone/desktop share the same component and the phone rule must not break desktop.
- Invent a new dialog grammar. Unlifted cards stay unlifted; they just stop presenting a fake Yes.
- Restyle the wheel slices or Keys dock beyond moving/hiding the handle.

## Files

| File | Change |
|---|---|
| `web/src/hooks/use-composer-state.ts` | Tighten `showYesNo` |
| `web/src/components/composer.tsx` | Wheel placement; YesNoStrip stays |
| `web/src/components/gesture-wheel.tsx` | Only if the handle must know `dialogPresent` |
| `web/src/hooks/use-pane-view.ts` | `focusFromMirror` |
| `web/src/components/option-button.tsx` | `min-h-11` on `optionSurface` |
| Colocated `*.test.tsx` / `*.test.ts` | Cover the three steal paths |
| `CHANGELOG.md` | Unreleased Fixed |

## Tests

- Blocked Claude/Grok/Cursor/Pi/Agy with a lifted dialog: no Yes/No strip.
- Blocked unknown/Codex agent with no dialog: Yes/No still shown.
- Blocked + `showYesNo`: wheel handle does not overlap the No button (role/query or layout assertion).
- Phone + blocked or `dialogPresent`: tap on dump text / PromptPanel padding does not focus the composer.
- `optionSurface` class includes `min-h-11`.
- Existing composer / agent-chat tests stay green.

## Done means

A blocked pane with buttons is one intended tap. Dump text, the wheel, and a near-miss cannot open Keys, fire Enter, type `yes`, or pop the keyboard over Allow.
