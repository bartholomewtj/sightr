# 24 — The guarded reply runs on the bridge

Status: done, live-tested 16 Oct 2026. Not a council slice.

## Problem

A reply from the phone runs the collie#34 guard in the browser (`web/src/lib/reply-action.ts`
`sendGuardedReply`). Every step is a phone↔bridge round trip:

1. pre-flight read: is the input box on screen?
2. if a draft is stranded in the box: `ctrl+k` + Backspaces, then a 350 ms settle, then a re-confirm read
3. type the text, unsubmitted
4. verify reads until the box shows the text (up to 8 × 350 ms)
5. the submit key(s)
6. reads until the box clears (up to 8 × 350 ms), plus a rescue Enter if it doesn't

Over mobile data that is six or more round trips at about 100–250 ms each, plus the settles: 1.5–2 s
for an ordinary send. The sweep is sized from the mirror's last poll (draft + 32, up to 96 keys), and
the bridge paces keys 80 ms apart, so a stranded draft adds up to 9 s. The phone telemetry for 16 Oct
shows one send request in the 2.5–5 s bucket and one past 6 s. On the bridge, the same read takes
about 15 ms.

## Change

Run the same guard on the bridge, as one request.

- **`web/src/lib/guarded-send.ts`** (new, leaf). The guard algorithm moves here unchanged, with its I/O
  injected: `read()`, `type(text, paste)`, `submit(keys?)`, `oneShot(text)`, `sleep`, and the poll
  pacing. `draftCarriesSend` and `ReplyOutcome` move with it. It imports only `blocks.ts`,
  `no-echo.ts` and types: no `react`, no `@shared`, no `api`.
- **`web/src/lib/harness/composer-kit.ts`** (new, leaf). Per agent, the input-box functions the guard
  uses: `composerReady`, `extractInputDraft`, `composerPrompt`, `unbindableComposer`,
  `draftCarriesSend`, `submitKeys`, `bracketedPaste`, `replyOneShot`. It is imported from the
  adapters' leaf files (`chrome.ts`, `paste.ts`, `chips.ts`), not from their `index.ts`. A test pins
  every field to the adapter's own by identity, so the two cannot drift (the same contract
  `dialog-sniff.ts` keeps).
- **Leaf rule.** Grok's and Cursor's chrome reach `shared/limits`, `shared/grok-prompt`,
  `shared/decision-marker` and (as types) `shared/wire` through `@shared`. Those six imports, in
  `grok/{chrome,markers,ask,ask-catalog}.ts` and `cursor/chrome.ts`, become relative paths. `shared/`
  files import nothing, so the closure stays free of `react`, `@shared` and packages, which the root
  typecheck enforces. CONTEXT and DECISIONS are unchanged.
- **`reply-action.ts`** keeps `sendGuardedReply` as the client-side runner: the core plus `fetchPane`
  and `sendReply`. It stays as the fallback, and its tests keep covering the core.
- **`bridge/guarded-send-route.ts`** (new). `POST /api/pane/:id/send` with `{ text, force? }` and the
  write access gate.
  - It runs the core inside the pane's write queue, so no other write can land between the steps.
  - Reads use `herdr.readPane(id, "recent", readLines, "ansi")`, the mirror's own read. Writes use
    `sendReplySteps` and `sendKeysPaced`.
  - The agent comes from the bridge's own snapshot, not the client.
  - Polls run every 100 ms, up to 28 times: the same 2.8 s budget, checked seven times as often.
  - It answers with the `ReplyOutcome` and audits it as `send`.
- **Sweep on the bridge.** It runs only when the pre-flight read positively saw the composer and that
  read's draft is not empty. Never under `force`. The key count comes from the live draft:
  `min(length + 8, 96)`, where the browser had to add 32 to cover a stale poll. It is followed by a
  350 ms settle and the existing re-confirm read.
- **Client.** `composer-send.ts` calls `api.sendGuarded(paneId, { text, force })`. On a 404 or 405 (an
  older bridge), it falls back to `sendGuardedReply` with the existing browser-side sweep. Outcomes
  map exactly as before.

## Invariants (unchanged, now enforced on the bridge)

- A pre-flight read that does not see the composer types nothing (`blocked`), unless `force`.
- Destructive keys go out only after a read positively saw the composer, never under `force`.
- `unbindableComposer` refuses with nothing typed, forced or not.
- The submit key is sent only after a read shows our text in the box (`stalled` otherwise).
- The rescue Enter goes only while a read still shows our text in the box.
- No adapter, or `replyOneShot` (Pi): the one-shot send, as before.
- A password prompt is named (`noEcho`) on both the pre-flight and the stall.

## Tests

- **Core:** the existing `reply-action.test.ts` suite passes unchanged through the client runner.
- **Kit:** each kit field is `===` its adapter's; the kit's agents equal the adapters' agents.
- **Bridge route,** with a fake Herdr (`bridge/guarded-send.test.ts`):
  - a plain send types, verifies, submits and returns `sent`;
  - no composer returns `blocked` with nothing written;
  - `force` types with no sweep;
  - a stranded draft is swept, then the reply is typed;
  - text that never shows returns `stalled` with no submit key;
  - Pi takes the one-shot path;
  - an unknown pane returns 404;
  - read-only access is refused.
- **Client:** `sendGuarded` posts `{ text, force }`. `composer-send` falls back on a 404.
- **Live, in a scratch herdr workspace created for the test:**
  - Claude: plain send, send over a stranded draft, send with a `/model` picker open (`blocked`), and a
    long send (paste token).
  - Pi: plain send (one-shot).
  - Shell: plain send (no adapter, one-shot).
  - Grok, Cursor and Agy only if they are installed and signed in. Otherwise record them as not
    live-tested.

## Live results (16 Oct 2026)

A test bridge from the branch ran on port 8799 with its own state directory. It used scratch herdr
workspace `sightr-send-test`, which was closed afterwards. Times are the whole `/send` request on the PC.

| Harness | Case | Outcome | Time |
|---|---|---|---|
| Shell | plain send (one-shot) | sent | 0.57 s |
| Claude 2.1.301 | first send after start | sent | 4.2 s (Claude still starting; the box showed the text late) |
| Claude | plain send | sent | 0.21 s |
| Claude | stranded 14-char draft | swept 23 keys, sent the new text only | 2.6 s |
| Claude | `/model` picker open | blocked, nothing typed | 4 ms |
| Claude | 21-line send (`[Pasted text]` token) | sent | 0.23 s |
| Pi | plain send (one-shot) | sent | 0.46 s |
| Grok | plain send | sent | 0.25 s |
| Cursor | trust prompt | blocked, nothing typed | 8 ms |
| Cursor | plain send (`Right`, `Enter`) | sent | 0.61 s |
| Agy | trust prompt | blocked, nothing typed | 7 ms |
| Agy | plain send | sent | 0.23 s |
| Agy | two-line send (bracketed paste) | sent, one prompt | 0.34 s |

Grok and Cursor answered with a usage-limit message, and Pi with a backend error. Each message
arrived and was submitted; the agents' replies are outside Sightr.

## Out of scope

Dialog taps, wizard and preview flows (`dialog-guard.ts`, `preview-action.ts`) keep their browser
round trips. They are one or two reads each, not six.
