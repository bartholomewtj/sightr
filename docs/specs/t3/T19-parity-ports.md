# T19 — Parity ports: gesture wheel, find, statusline, whistlr cards

Status: draft (T3-shape series). Depends on: T04 (`via: "whistlr"` and `decision` on requests), T11 (timeline), T12 (composer and `RequestPanel`), T13 (Terminal tab, `chat.find` binding), T18 (Settings slot for the wheel picker). Read `README.md` in this folder first.

## Problem

Four v1 features have no home in web2 after T09–T14 and T18, and T15's parity checklist names them: the phone's gesture
wheel, find (in the chat and over the mirror), the harness statusline, and draftr operator-decision cards answered with
`whistlr reply`. Each is a port of v1 code, not new behaviour.

## Change

### Gesture wheel (phone composer)

- Copy `web/src/components/gesture-wheel.tsx`, `hooks/use-wheel-prefs.ts` and `components/wheel-prefs-control.tsx`;
  import `@v1/lib/wheel` (`SHIPPED_WHEEL`, `wheelChoices`, `MAX_SLICES`, `HOLD_MS`, `DEAD_ZONE_PX`) through T09's
  `v1-scope` resolver.
- The wheel sits beside Send in T12's composer on touch devices. Hold fans the slices; release on a slice runs it.
  Key slices send through the shared keys dock's sender (T12/T13), so they queue and pace as the pad does. The Type
  slice opens the Terminal tab and arms direct typing (T13).
- The picker goes in T18's Gesture wheel slot. Operator rows from `keys.toml` appear as in v1.
- A pending runtime request disables the wheel; T12's panel owns the area then.

### Find

- **Timeline.** `mod+f` (T13's `chat.find`, `!terminalFocus`) and a search icon in the thread header open a find bar
  over the timeline (copy `find-bar.tsx`; the matcher is `@v1/lib/find`). It searches the thread store's items in
  memory, including collapsed work-log groups, which it expands on a hit. Next and previous scroll the hit into view
  through T11's windowed list. It does not page history; the bar says "Loaded messages only" while older pages exist.
- **Terminal tab.** The same bar over the mirror's text, as v1 does (`lib/find.ts`, `lib/find-request.ts`). It searches
  only what the mirror has read.
- Escape closes the bar; the highlight is cleared on close.

### Statusline

- The Terminal tab header shows the harness's statusline rows: `adapterFor(thread.harness)` from
  `@v1/lib/harness/registry`, then that adapter's `extractStatusLines` over the mirror's lines. No harness id appears in
  web2 code (T08's lint rule). A harness with no `extractStatusLines` shows nothing.
- It updates with the mirror's own polls, so it costs no extra read and shows only while the Terminal tab is open.

### Whistlr decision cards

- T04 publishes a marked draftr card as a `question` request with `via: "whistlr"`, `decision: { thread, run }`, and
  option labels with empty `keys`. `RequestPanel` (T12) renders it as a decision card: the prompt and one button per
  option.
- A tap posts the v1 route `POST /api/pane/:paneId/decision-reply` with the option and the `decision` (copy
  `decisionReply` from `web/src/lib/api.ts`; the body shape is v1's `DecisionReplyRequest`). The bridge runs
  `whistlr reply` (`bridge/decision-reply.ts`). Nothing is typed into the pane, and `runtime-request.respond` is never
  posted for this request.
- The button stays busy until the request leaves `pending` (the card leaves the screen). A failed reply shows the
  bridge's error and keeps the card.
- An unmarked request keeps T12's key path.

## Invariants

- A `via: "whistlr"` request never sends keys and never posts `runtime-request.respond`.
- The wheel and find add no bridge route and no pane read of their own.
- No web2 file names a harness id; the statusline goes through the adapter registry.

## Tests

- **Wheel:** hold fans six slices; release on a key slice sends its keys through the dock sender; Type opens the
  Terminal tab with direct typing armed; the Settings picker round-trips; a pending request disables it.
- **Find (timeline):** a hit inside a collapsed group expands it and scrolls to it; next and previous wrap; the "Loaded
  messages only" note shows while a history cursor remains; `mod+f` is ignored while direct typing is armed.
- **Find (Terminal tab):** highlights and steps over the mirror text.
- **Statusline:** a Claude fixture shows its statusline rows in the header; a harness without the function shows none;
  the lint test finds no harness id literal.
- **Whistlr** (msw): a marked request posts `decision-reply` with the option and `decision` and never `/api/v2/command`;
  an unmarked request posts `runtime-request.respond`; a failed reply keeps the card.
- **Live** (scratch workspace): a marked draftr card answered from web2 reaches `whistlr reply`; the wheel on Bart's phone.

## Notes for the planner

- The four parts are independent. If the run is long, ship whistlr cards first: until they land, a marked card has no
  answer in web2 except the desk.
