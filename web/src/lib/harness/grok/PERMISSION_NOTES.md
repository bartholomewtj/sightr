# Grok permission card — keystroke recipe

Captured 2026-08-21 and 2026-08-22 on Grok Build 1.0.5 in a sandbox pane (`herdr agent start
groksandbox --kind grok -- --permission-mode default`). Ask mode. The card **replaces** the
composer (no `╭ ❯ ╰` at the tail). The live light-gutter variant was captured 2026-09-01 on
sandbox pane `w6P:p1`. Herdr status: `blocked`.

The option count varies by tool class — two layouts captured:

```
┃  <title>
┃  <command>
┃  1 (●) Yes, and don't ask again for anything (always-approve mode)
┃  2 (○) Yes, proceed
┃  3 (○) No, reject (type to add feedback)
1/3:select  │  Tab:next option  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback
```

```
┃  Allow Edit to <full path>?
┃  1 (○) Yes, and don't ask again for anything (always-approve mode)
┃  2 (○) Yes, allow all edits during this session
┃  3 (●) Yes
┃  4 (○) No, reject (type to add feedback)
1/4:select  │  Tab:next option  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback
```

The earlier cards put the reject last and the one-shot Yes immediately above it. The
2026-09-01 capture proves that positional rule dead: the live card has a persistent `Never allow`
row after the reject. The safe invariant is instead exactly one one-shot Yes above exactly one
reject, with every other option provably persistent. The footer names the card family and counts
its rows (`1/N:select`).

The complete 2026-09-01 live card is:

```text
  │  Remove hello.txt file
  │  rm hello.txt
  │  ← → narrow scope  ·  e edit pattern
  │
  │  1 (•) Yes, and don't ask again for anything (always-approve mode)
  │  2 (○) Always allow: rm hello.txt
  │  3 (○) Yes, proceed
  │  4 (○) No, reject (type to add feedback)
  │  5 (○) Never allow: rm hello.txt
  │
  1/5:select  │  Tab:next option  │  ←/→:scope  │  e:edit pattern  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback
```

The live card uses the light `│` gutter and `(•)` U+2022 BULLET. The adapter lifts only rows 3
and 4 as tappable buttons. Live probes confirmed:

| Key | Effect |
|---|---|
| `3` | Confirms **Yes, proceed** immediately; the file was deleted. |
| `4` | Confirms **No, reject** immediately; the file remained and the next `rm` re-asked. |

Do not emit `1` (always-approve), `2` (Always allow), or `5` (Never allow): these are persistent
by label and were not probed as buttons. Do not emit `←`, `→`, or `e`; file-write did not paint a
permission card.

Live-probed:

| Key | Card | Effect |
|---|---|---|
| `Tab` | rm (2026-08-21) | Cycles the `●` 1 → 2 → 3 → 1. Does not confirm. |
| `Enter` | rm (2026-08-21) | Confirms the **highlighted** option. Default highlight on the first card was option 1 (always-approve); on both edit cards it was the one-shot Yes. |
| `2` | rm (2026-08-21) | Confirms **Yes, proceed** immediately, even when `●` is on option 1. Does not persist always-approve (status stayed `Grok 4.6 (high)`). |
| `3` | rm (2026-08-21) | Confirms **No, reject** immediately, no feedback field. |
| `3` | edit (2026-08-22, twice) | Confirms **Yes** immediately. Does **not** persist: the very next edit in the same session re-asked (negative control). |
| `4` | edit (2026-08-22) | Confirms **No, reject** immediately; the file was never written. |
| `3` | rm (2026-09-01, `w6P:p1`) | Confirms **Yes, proceed** immediately; the file was deleted. |
| `4` | rm (2026-09-01, `w6P:p1`) | Confirms **No, reject** immediately; the file remained and the next `rm` re-asked. |
| `q` | rm (2026-08-21) | Not a permission key. |

Not probed (so not emitted): digit `1` (always-approve), digit `2` (Always allow), digit `5`
(Never allow), `←`, `→`, `e`, and `Ctrl+o`. The first three are persistent by label; the latter
three change scope or edit the pattern.

What the adapter emits — the bottom Yes/No pair only, and only when every row proves its class:

- The footer must carry all of `1/N:select`, `Tab:next option`, `Ctrl+o:always-approve`,
  `Ctrl+c:cancel`, and `N` must equal the number of option rows.
- Options must be consecutive unique `1..n` radio rows in one contiguous gutter run (`┃` or `│`),
  with nothing but a couple of blank rows between the card and its footer (the captures show exactly
  one). The permission predicate accepts the live `(•)` mark as well as the earlier `●`/`○` marks.
- The unique reject row → **No** button: label must start `No, reject`; the unique one-shot Yes
  row must be above it, start `Yes`, and NOT match a persistence marker.
- Every other row must match a persistence marker (`always-approve`, `don't ask again`, `always
  allow`, `never allow`, `this session`) — those are never buttons. A row we cannot prove persistent refuses
  the **whole card**: its semantics are unprobed.
- At least one persistent upper row must exist (`n >= 3`): the footer advertises
  `Ctrl+o:always-approve`, so a bare Yes/No card would contradict its own footer — no capture
  has ever shown one.

Cancel stays on the Keys pad (`ctrl+c`). Typing on the No row for a feedback message was not
captured; the digit rejects immediately without one.

.adr/0009 still holds for *generic* menus. This is a specific probed grammar: the digit-confirms-
immediately mechanism was verified on the earlier layouts and the live card, while the
classification refuses any card that steps outside what was probed.
