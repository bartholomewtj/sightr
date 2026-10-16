# T04 — Runtime requests: dialogs as answerable cards

Status: done on feat/v2 (2026-10-16). Depends on: T01, T02 (T03 for Grok question cards).

## Problem

When an agent waits on the operator, v1 lifts a dialog block in the browser from the pane text and sends bound
keys through `POST /api/pane/:id/keys` with `expected_prompt`. v2 clients are driven by events, so the bridge
must do the parsing itself, publish a `runtime-request`, and execute the answer. The parts exist but are in
the wrong places: the browser-side detectors are not importable as one call, and the bridge's prompt-binding
check (`checkPromptBinding` in `bridge/pane-write-routes.ts`) is private and reads with `source: "recent"`.

## Change

- **`web/src/lib/harness/dialog-kit.ts`** (new, leaf). `parseDialog(agent: string, ansiText: string): DialogParse | null`
  where `DialogParse = { kind, prompt, options: { label, keys, destructive? }[], boundText }`.
  Same pattern as `dialog-sniff.ts` and `composer-kit.ts`: it calls the adapters' leaf detectors directly
  (Claude `prompt-select`/`menu`, Cursor `permission`/`trust`/`ask`, Agy `prompt-select`, Grok `ask`) and
  builds the result from `PromptModel` (`question`, `options[].keys`, `family`). Rules:
  - Leaf imports only. Where a detector reaches `@shared` (Claude's `chrome.ts` does), change those imports to
    relative paths the way spec 24 did. The root typecheck enforces it.
  - A test pins `parseDialog` to each adapter's own detector on every fixture (the `dialog-sniff` contract).
  - Exact agent strings, no prefixes. An agent with no parser returns null.
  - `kind`: family `permission` → `permission`, `trust` → `trust`, a password prompt (the no-echo detector,
    ADR 0017) → `password`, a free choice → `menu`, a question card (Cursor/Grok ask, Claude plan or
    ask) → `question`.
  - `boundText` = the last 12 non-blank lines of the read after `normalizePromptRegion`, so the region sits
    inside the matcher's tail window (`PROMPT_TAIL_LINES` is 6 non-blank lines).
  - `destructive` is set when the option's label matches the adapter's own "deny/abort/always allow" lists;
    nothing new is invented, and an option with no list entry is not marked.
- **`bridge/threads/request-ingest.ts`** (new). `createRequestIngestor({ store, engine, herdr, queue, now, newId })`.
  - **Trigger.** On each reconcile (T02), a thread with status `input`/`approval` (herdr `blocked`, which
    includes the engine's `dialogDetected`) is *requesting*. Read `herdr.readPane(paneId, "visible", 60, "ansi")`
    inside `queue.run(paneKey(paneId), …)` so a read cannot land between a reply's steps. `visible`, not
    `recent`: the scroll caveat in `docs/HERDR_API.md` applies to this background read as to the engine's.
  - **Open.** `parseDialog(harness, text)` non-null → compute `bindingHash = sha256(boundText lines joined)`.
    No open request for the thread, or a different hash → `runtime-request.updated` (`pending`, new id when
    the hash changed; the old one first goes `resolved` or `expired`). The thread's status moves to
    `approval` for `permission`/`trust`, else stays `input`. `bound_text` is stored server-side only.
  - **Throttle.** A requesting thread is re-read every poll (the dialog can change under it), an unchanged
    hash emits nothing. A failed read keeps the request as is and tries again next poll.
  - **Parse miss.** Blocked but nothing parses: no request. The thread stays `input`, and the client shows the
    Terminal tab. This is the honest fallback, not an error.
  - **Close.** When the thread leaves `input`/`approval`, or the next read no longer parses: if the thread's
    last `runtime-request.respond` committed, `resolved`; otherwise `expired` (answered at the desk, or the
    run ended). The pane archiving expires it too (T02).
  - **Draftr cards.** A dialog whose text carries a draftr operator-decision marker (`shared/decision-marker.ts`,
    `bridge/decision-marker.ts`) still routes through whistlr (`bridge/decision-reply.ts`, route
    `decision-reply`). The ingestor publishes it with `kind: "question"`, `via: "whistlr"`, the marker as
    `decision: { thread, run }` (from `PromptModel.decision`), and options that carry labels with `keys: []`;
    `respond` on it is rejected with `code: "invalid"`. The client answers it through the v1 route
    `POST /api/pane/:id/decision-reply`, which runs `whistlr reply` (T19 builds that card). Nothing here types a
    whistlr decision into the pane.
  - **Push.** The existing path is untouched: `engine.onTransition → notifications.onTransition` in
    `bridge/index.ts`. Runtime requests do not send pushes.
- **Respond.** `bridge/threads/respond.ts`, the handler T05 calls for `runtime-request.respond { requestId, optionIndex }`:
  1. Load the request. Not `pending`, or `optionIndex` out of range → reject (`conflict` / `invalid`).
  2. `queue.run(paneKey(paneId), …)`: read the pane with `visible`, verify `boundText` with
     `verifyExpectedPrompt` (`shared/prompt-binding.ts`). Refuse with `code: "prompt-changed"` and mark the
     request `expired` if it no longer matches. This is the same matcher v1 uses, so v2 is exactly as strict.
  3. Send `options[i].keys` with `sendKeysPaced` (`bridge/pane-write-routes.ts`), one key per Herdr write.
  4. Commit `runtime-request.updated` with `status: "resolved"` and the chosen index, and the command receipt.
  - To share the check, export `checkPromptBinding` from `pane-write-routes.ts` with a `source` parameter
    (default `"recent"`, so v1 is unchanged); v2 passes `"visible"`. Its audit record is written with action
    `keys` and `promptBinding`, as v1 does.
  - A `password` request has no options; it cannot be answered with `respond`. The client shows the Terminal.
  - Multi-select, wizard and preview-select dialogs (Claude/Grok/Cursor checkbox asks, multi-question asks, the
    preview variant) are published `question` with no options in this slice; the Terminal tab handles them.
    T17 adds their fields and answers them. Free-text rows (Claude's plan feedback, Pi's type-in row) are not
    options and stay in the Terminal tab. Row 4 is out of scope.

## Invariants

- Keys go out only after a fresh read matches the request's `boundText`; a stale binding sends nothing.
- The read and the key send for one `respond` happen inside one pane-queue turn.
- `boundText` and raw keys' provenance stay server-side except `options[].keys`, which clients may display.
- Marked draftr cards are never typed by this code.
- A dialog that does not parse produces no request and no guess at keys.
- No background read uses `source: "recent"`.

## Tests

Fake Herdr (scripted `readPane` per call, records `sendPaneKeys`), temp sqlite, the pane fixtures under
`web/src/fixtures/panes/`.

- **dialog-kit (web Vitest):** per-fixture pin to each adapter detector; password prompt → `password`; leaf
  closure has no `@shared`/`react` (the existing import-closure test pattern).
- **Open/update:** a Claude permission fixture → one pending `permission` request, status `approval`; the same
  screen next poll → no new event; a different screen → old expired/resolved, new pending.
- **Close:** dialog gone after a respond → `resolved`; gone with no respond → `expired`; pane archived → `expired`.
- **Respond (happy):** matching screen → keys sent in order via paced writes, request resolved, receipt written.
- **Respond (stale):** screen changed between detect and respond → `prompt-changed`, zero keys sent, request expired.
- **Respond (bad):** unknown request id, already resolved, index out of range, `password`, whistlr card.
- **Queue:** a respond and a concurrent `message.dispatch` on one pane run one after the other (assert order).
- **Parse miss:** blocked pane with an unparseable screen → no request, status `input`.
- **Whistlr:** a marked draftr card → `via: "whistlr"`, `decision` set, every option's `keys` empty; `respond` rejected.
- **v1 regression:** `keysPane` with `expected_prompt` still 409s on a changed screen and still reads `recent`.

## Notes for the planner

- This is the riskiest slice for the leaf-import rule: Claude's detectors pull `chrome.ts`. Budget the
  import rewrite first; if it grows, ship Cursor and Agy (already leaf, covered by `dialog-sniff.ts`) plus
  Claude, and leave Grok and Pi for a follow-up.
- `bindingHash` is only identity for the client; the authority is `boundText` verified by the bridge.
- The 12-line `boundText` is a guess at "enough of the dialog, inside the 6-line tail". Tune against the
  fixtures; a dialog taller than 12 lines may need a harness-specific window.

## Built

Files: `web/src/lib/harness/dialog-kit.ts` (+ test), `bridge/threads/request-ingest.ts` (`createRequestIngestor`,
`bindingHash`, `requestingStatus`), `bridge/threads/respond.ts` (`createRespondHandler`), `bridge/threads/request-items.ts`
(the request's timeline item), `bridge/threads/request-ingest.test.ts`. Wired in `bridge/index.ts`: one pane write queue is
now built there and passed to `startServer` (new `paneWrites` option), and the request ingestor starts after the herd and
journal ingests. T05 routes `runtime-request.respond` to `requestIngestor.respond(command, { commandId })`.

Deviations from the draft:

- **The kit holds each adapter's own `buildBlocks`**, not a re-wired list of leaf detectors. After three import rewrites
  (`claude/prompt-select.ts` and `pi/ask.ts` reached `@shared/decision-marker`, `grok/index.ts` reached `@shared/wire` as a
  type) every adapter's `index.ts` closure is leaf, so the kit runs the phone's exact arbitration order (Claude: preview,
  wizard, multi-select, prompt-select, menu). The test pins each entry `===` the adapter's `buildBlocks`, checks every
  fixture of every agent, and walks the import closure (no package, no `@shared`). Claude's `chrome.ts` was already leaf;
  Grok and Pi are included, not deferred.
- **Kinds:** prompt-select family `permission`/`trust` map to themselves; `select` and `plan` (all ask cards and plan
  approvals) are `question`; a `MenuModel` (Claude's generic menu, Grok's plan menu) is `menu` with its footer actions as
  options. Wizard, multi-select and preview-select are `question` with no options (T17). A prompt whose free-text row is
  focused is published with no options (every digit would be typed into the row).
- **`destructive`:** the only deny lists the adapters have are Cursor's `Skip` and Grok's `No, reject` rows (now exported as
  `isSkipLabel` / `isRejectLabel`), plus a menu action's own `cancel` flag. Claude and Agy have no list, so their `No` is
  not marked.
- **Timeline items (T3 shapes):** every `runtime-request.updated` is written with a `turn-item.updated` in the same batch:
  `approval_request {requestId, requestKind, prompt, options: [{label}]}` for permission/trust/menu/password,
  `user_input_request {requestId, questions: [{id: "q1", header: "Question", question, options}]}` for a question. Item id
  `request:<requestId>`; status `waiting` → `completed` (resolved) or `cancelled` (expired). The herd ingest's archive path
  now expires the item too.
- **`RuntimeRequest.runId?`** added to `shared/v2/contracts.ts`: the run open when the dialog appeared, so the item belongs
  to it and the herd ingest can rebuild the item without a store read.
- **Store reads added:** `getRequest(id)`, `requestBoundText(id)` (server-side only).
- **Close:** `resolved` is written by `respond` itself (step 4), so the ingestor only ever expires. After a respond, the
  same screen does not reopen a request for `RESOLVED_GRACE_MS` (3 s): the read right after the keys can still show the
  old dialog. A dialog still there past that (the keys did not take) is published again.
- **The parser is chosen by the pane's raw Herdr `agent`** (exact string, as v1's phone does), not the thread's canonical
  `harness`.
- **Respond codes:** `not_found`, `conflict` (not pending, archived, unbound), `invalid` (bad index, `optionIndices`,
  password, no options, whistlr card), `prompt-changed`, `busy` (pane queue timeout), `failed` (read or key send failed).
  The receipt (`runtime-request.respond`, result `{requestId, optionIndex}`) is written only on success; a
  `prompt-changed` expiry carries the `commandId` but no receipt. The request is re-checked inside the queue turn, so one
  the ingestor expired while respond waited sends nothing.
- `boundText` is 12 lines as drafted; every fixture's dialog verifies against its own screen with it. Not live-tested
  against herdr.
