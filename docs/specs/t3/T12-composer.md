# T12 — Composer: send, queue, steer, requests

Status: done on feat/v2-web (2026-10-17). Depends on: T09, T06 (`message.dispatch`, queue, interrupt), T04 (runtime requests), T11 (timeline for the sent message). Read `README.md` in this folder first.

## Problem

v1's composer (`web/src/components/composer.tsx`, `hooks/use-composer-state.ts`, `lib/composer-send.ts`) runs the guard from the phone, keeps its draft by pane id, and shows agent dialogs as
buttons under a polled terminal dump. In v2 the bridge sends (spec 24 logic, T06), keeps a persisted queue, and publishes dialogs as runtime requests. The composer has to
become: a text box, a button whose meaning follows the run state, a queued list, and, when the agent asks something, a panel that replaces the box.

T3 reference (patterns only; MIT, comment the source if logic is adapted): T3: `apps/web/src/components/chat/ChatComposer.tsx`, `chat/QueuedRunsControl.tsx`, `chat/queuedMessageEdit.ts`,
`chat/ComposerPendingApprovalPanel.tsx`, `chat/ComposerPendingApprovalActions.tsx`, `chat/ComposerPendingUserInputPanel.tsx`, `docs/user/composer.md` (Send while the agent is working).

## Change

All in `web2/src/components/composer/` and `web2/src/state/composer.ts`, filling the Chat slot's bottom region.

### Text box

- A plain `<textarea>` that grows to 8 lines then scrolls. No rich editor: phone dictation and IME must work (`isComposing` and keyCode 229 never send). `autocapitalize="sentences"`, `enterkeyhint` follows the setting.
- **Enter setting** (per device, `localStorage`, default by device: desktop "Enter sends", phone "Enter adds a line"): "Enter sends; Shift+Enter adds a line" or "Mod+Enter sends; Enter adds a line". On a phone the on-screen send button is the main path.
- **Drafts.** Copy `web/src/lib/drafts.ts` to `web2/src/lib/drafts.ts` keyed by `threadId` (its prune and size rules stay). The draft clears when the bridge confirms `message.dispatch` (the `{ sequence }` reply), not at tap; on a failed command the text stays.
- Limit 120,000 characters. A paste of 32 KiB or more asks "Attach as a file instead?" rather than inserting. Multi-line paste into a thread whose harness is destructive-sensitive is checked with `isDestructiveInput` from `@v1/lib/destructive`; a hit asks for a second tap, as `planSendTap` does in v1.

### Button states

One primary button; its state comes from the thread's status and the queue, never from the text alone:

| Thread state | Text empty | Text present |
|---|---|---|
| idle / done / failed | disabled "Send" | **Send** (`mode: start`) |
| working | **Stop** (`run.interrupt`) | **Queue** or **Steer** (the setting, below) with Stop beside it |
| approval / input | the request panel owns the area | (none) |
| pane gone / read-only device | disabled, with the reason | disabled |

- **Follow-up setting** (per device): Queue (default) or Steer. `mod+Enter` while working does the other one, as T3 does (T3: `docs/user/composer.md`). Queue sends `message.dispatch {mode: queue}`; Steer sends `{mode: steer}` (T06: interrupt key, wait idle, send).
  Steer shows only when `capabilities.canInterrupt && capabilities.canQueueDrain` (T01 names, values from T08); otherwise the button reads Queue only.
  Queue shows only when `canQueueDrain`; a plain shell thread has neither, so while it works the button is Stop alone (when `canInterrupt`).
- `mod+shift+Enter` steers the oldest queued message; `alt+ArrowUp` at the start of an empty box edits the newest queued message. Keys register through T13's table; until then, local handlers.
- A tap on Send/Queue/Steer disables the button until the command reply arrives (a double tap cannot post two; the `commandId` also makes it idempotent).
- Read-only devices (`isReadOnly(device)` from the shell snapshot) see a read-only banner and a disabled box.

### Queued list

- Above the box, a collapsible "Queued (3)" list from `thread.queue` in the store. Each row: position, first line of text, attachment count, drag handle, Edit, Steer now, Cancel.
- **Reorder:** drag (pointer) or the Up/Down buttons on the row menu; sends `queued.reorder`. **Edit:** puts the text in the box with an "Editing queued message" chip; sending sends `queued.edit` and returns to normal; Escape discards the edit. **Cancel:** `queued.cancel`, 5 s Undo toast (re-queue at the same position).
- **Persisted.** The queue is bridge state. After a bridge restart the rows are `held` (`heldReason: "restart"`); the list shows "Paused after restart" with a single Resume button. Resume sends `queue.resume {threadId}` (T06); the bridge drains from the head when the pane is idle. A row held for another reason (three failed sends) shows the reason and the same Resume.
- A queued message that the bridge dropped (pane closed) shows "Not sent: pane closed".

### Attachments

- Attach button, paste and (desktop) drag-and-drop. Upload goes to the existing `POST /api/pane/:paneId/upload` through a copy of `uploadImage` from `web/src/lib/api.ts`, using the thread's `paneId`. The reply carries the path the agent can read; the chip holds it, and `message.dispatch` sends `attachments: [{ path, name }]` (T06's shape).
- Uploads start on add; Send waits for all of them. A failed upload shows Retry and Remove on its chip. Accept list as in v1's `composer.tsx` file input.
- Copy `web/src/hooks/use-drop-upload.ts` and adapt it to threads.

### Slash catalog and operator commands

- A `/` at the start of the box opens a menu above it: `commandsFor(thread.harness, operatorCommands)` from `@v1/lib/agent-commands`, which already prefers the operator's `commands.toml` rows (ADR 0018). Commands without arguments send on pick;
  commands with `takesArg` insert `/name ` for the user to finish. `dangerous` commands need a second tap. Operator rows come from `GET /api/config` as in v1 (`useOperatorCommands` shape; copy the hook).
- Filter by prefix as you type. Arrow keys and Enter pick on desktop.

### Keys pad on phone

- A "Keys" button (phone and touch only; desktop uses the Terminal tab, T13) opens an in-flow dock above the box, not an overlay, so the timeline stays visible. It contains the existing key pad: copy
  `nav-tray.tsx`, `key-queue-strip.tsx` and the hooks `use-key-queue.ts`, `use-ordered-key-sender.ts`, `use-hold-repeat.ts`, `use-action-echo.ts`, with `@v1/lib/key-queue` and `@v1/lib/operator-keys` for the logic. Keys go to the existing `POST /api/pane/:id/keys` helper (`sendKeys`).
  Presets come from `keys.toml` as in v1. The gesture wheel is T19, not this slice.

### Pending request replaces the composer

- When the thread has a runtime request with `status: pending`, the box area is replaced by `RequestPanel`. The panel is the page's "you" step: accent-soft fill, accent border, accent heading.
- Common: the prompt text (Consolas for command lines), then one `OptionButton` per `options[]`, min height 44 px. Copy `web/src/components/option-button.tsx`. Tapping sends `runtime-request.respond {requestId, optionIndex}` and shows a busy state on that button until the request leaves `pending`.
- **permission / trust:** options as the bridge labels them ("Yes", "Yes, don't ask again", "No"). An option with `destructive: true` needs a second tap ("Tap again to confirm") and uses warn tokens; it is never the first button.
- **question:** the options as buttons. T04 has no free-text answer; a question with no options (a free-text row, or a multi-select, wizard or preview dialog before T17) shows the prompt, "Answer in the Terminal tab" and an Open terminal button. T17 adds checkboxes, step chips and the preview to this panel.
- **whistlr** (`via: "whistlr"`): never posts `runtime-request.respond` and never sends keys. Until T19 it shows the prompt and "Answer with whistlr reply" with no option buttons; T19 adds the decision card.
- **menu:** the menu's options in order with the current one marked; tapping moves and selects through the bound keys (T04), and shows the bridge's verdict.
- **password:** no echo. The panel says "This asks for a password. Sightr does not send it. Type it in the Terminal tab." and has an Open terminal button (T13). No input field.
- **expired:** if the request leaves the screen without an answer from here, the panel is replaced by the box and a notice "Answered elsewhere".
- Escape (desktop) does nothing; there is no cancel unless an option says so.
- The panel remains reachable by keyboard: the first option takes focus on appearance, but only when the box was not focused (never steal typing).

### Banners

A banner stack above the composer, one row per condition, newest worst-first, each dismissible only where it can clear itself:
**Bridge link** (the stream is `lost`, from `useStreamHealth`): "Not connected. Sending is paused." · **herdr down** (shell snapshot `bridge: "disconnected"`): "Herdr is not reachable on the host." · **Error** (last `message.dispatch` failure or a run `failed`): the reason and a Retry that re-sends the same text (`textDelivered` false only, mirroring the v1 `ActionResponse` rule) ·
**Read-only device**.
While `lost`, Send is disabled but the draft is kept.

## Invariants

- The browser never types into the pane to send; it posts `message.dispatch`. The v1 guard stays on the bridge.
- A button tap cannot post two dispatches for one tap.
- A password prompt never receives text from Sightr.
- A destructive option needs two taps, and is never default-focused.
- The draft survives a reload and a failed command; it clears only on a confirmed dispatch.
- The queue shown is the bridge's queue, not local state.

## Tests

- **Button matrix:** each row of the table renders the right label and enabled state; Stop sends `run.interrupt`; Queue vs Steer follows the setting; `mod+Enter` flips; steer hidden unless `canInterrupt && canQueueDrain`; queue hidden without `canQueueDrain`.
- **Enter setting:** both modes; IME composition never sends; phone default is "adds a line".
- **Draft:** saved per thread; cleared on confirmed reply only; kept on 500; large paste prompts.
- **Destructive text** needs a second tap.
- **Queue:** reorder posts `queued.reorder`; edit flow posts `queued.edit`; cancel then Undo re-queues in place; "Paused after restart" shows Resume and posts `queue.resume`; dropped message notice.
- **Attachments** (msw upload): chip states, Send waits for uploads, retry, remove, payload shape.
- **Slash menu:** operator rows replace the catalog on a pane they address; no-arg sends, arg inserts; `dangerous` needs two taps.
- **Keys pad:** opens in flow, sends keys through `sendKeys`, hidden on desktop width.
- **RequestPanel:** permission with destructive option; question with options; question with no options shows Open terminal; menu; password (no input, Open terminal button); a `via: "whistlr"` request posts nothing; expired replaced by box; busy state until the request leaves `pending`; focus rule.
- **Banners:** lost stream disables Send and keeps the draft; herdr down; error with Retry.
- **a11y:** the panel is a labelled region; buttons have names; `aria-live` announces a new request.

## Built

Files (T3 names, `web2/src/components/chat/`): `ChatComposer.tsx` (+ `.logic.ts`, tests), `ComposerPrimaryActions.tsx`,
`ComposerPendingApprovalPanel.tsx`, `ComposerPendingApprovalActions.tsx`, `ComposerPendingUserInputPanel.tsx`,
`QueuedRunsControl.tsx`, `ComposerBanner.tsx`, `ComposerBannerStack.tsx`, `composerSlashCommandSearch.ts`,
`ComposerCommandMenu.tsx`; state in `web2/src/state/composer.ts`. T3's `composerDispatch.ts` and `searchRanking.ts` are
verbatim ports under `web2/src/t3/` (aliased as `@t3tools/...`). All rows are in `web2/t3-upstream.json`. v1 copies:
`lib/drafts.ts` (keyed by thread id), `lib/operator-commands.ts`, `components/nav-tray.tsx`, `components/key-queue-strip.tsx`,
`hooks/use-key-queue.ts`, `use-hold-repeat.ts`, `use-action-echo.ts`, `use-pending-confirm.ts`, `use-drop-upload.ts`
(adapted to hand every dropped file to the composer); `uploadImage`, `sendKeys` and `fetchConfig` added to
`web2/src/lib/api.ts`. Live-checked against a Claude Haiku pane: send, queue while working, Stop (the queue then drained),
Keys pad (Shift+Tab), and a Write permission answered from the panel.

Deviations:

- **Folder:** `components/chat/` with T3's file names, not `components/composer/` (README "same layout and names").
  `RequestPanel` is `ComposerPendingApprovalPanel` (permission, trust, menu, password, whistlr) and
  `ComposerPendingUserInputPanel` (question), both on `ComposerPendingApprovalActions`. `option-button.tsx` was not copied:
  T3's actions component took its job (44 px rows, busy state, warn tokens for destructive).
- **Limit:** 64 KiB (the bridge's `MAX_DISPATCH_CHARS`), not 120,000; the bridge refuses longer text.
- **Bridge/contract additions** (needed for two banners; small, additive): `ShellSnapshot.herdr` and `.device` (only when
  per-device auth is on), and `SequenceFrame.herdr` on `synchronized` and `ping`. web2 keeps them in `useBridgeInfo`; a
  command refused with "device not authorised" also marks the device read-only. `ThreadState.dispatchFailure` holds the
  newest `dispatch.failed` (with `commandId`), so a guard-refused start (200 + event) still shows the error, puts the text
  back in an empty box and offers Retry.
- **Steer now** on a queued row is `message.dispatch {mode: steer}` then `queued.cancel` (there is no promote command).
  **Undo** after a cancel re-queues the text and then posts `queued.reorder` to put it back at its old index.
- **Destructive text** is checked on every send (as v1's composer does), not only "destructive-sensitive" harnesses:
  there is no capability flag for that.
- **Enter:** in "Mod+Enter sends" mode, Mod+Alt+Enter does the other follow-up (Mod+Enter is the send itself).
- **Slash search** uses T3's ranking: prefix matches first, then word-boundary, substring and fuzzy matches.
- **Menu requests** show options in order but cannot mark the current one: T04's request has no current index. A
  destructive option (a menu's own cancel) moves to the end.
- **Open terminal** links to v1's pane view (`/pane/:paneId`) until T13's Terminal tab exists.
- **Settings** (Enter mode, Queue or Steer) live in a small menu in the composer until T18's settings route.
- `use-ordered-key-sender.ts` was not copied: the Keys pad sends one press per call, as v1's tray does.
- Keys register locally (Enter rules, Mod+Shift+Enter, Alt+ArrowUp, Escape); T13 moves them into its table.

