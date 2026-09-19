# 31F-sightr — operator-decision answer bridge

One sdlc run. Do not start a second pipeline. Do not start Jev. Do not implement 33. Do not re-run pack 03. Do not resume draftr 31F run `5a81defb`. Do not touch the draftr or whistlr repos.

## Why

draftr 31F can echo parser-shaped claude/grok/pi cards into the invoking pane. Sightr already lifts harness ask-cards from the pane log and sends keys back to the pane. That key path does **not** post `whistlr reply`. Echo is not a live harness dialog, so keys would type into the invoking agent. Nothing maps the operator's pick to `whistlr.decision_response.v1`.

This slice is the missing bridge: when the lifted card is a draftr operator decision, the phone pick submits `whistlr reply --payload` and does **not** send keys.

## Marker contract (draftr will emit; parse it here)

A decision card includes this line in the lifted region (question line or last line of the card — pick whichever existing parsers keep):

```
whistlr.decision thread=<uuid> run=<8hex>
```

Example: `whistlr.decision thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee run=5a81defb`

- `thread` is the queue-head `thread_id` (31D already has it).
- `run` is the draftr run id.
- Unmarked prompt-select / wizard / multi-select is **unchanged** (keys only, no whistlr).

draftr 31F will add this trailer when that run is finished later. This slice must parse it from fixtures that match the 31F ASCII shapes in draftr `src/decision-card.ts` (`renderClaudeCard`, `renderGrokCard`, `renderPiCard`) **plus** the marker. Do not open the draftr repo. Recreate those shapes from the request and from existing sightr claude/grok/pi ask fixtures; add the marker line.

Parse rules:

- Full match, one line, optional surrounding whitespace.
- `thread` = UUID `8-4-4-4-12` hex (accept upper or lower).
- `run` = exactly 8 hex chars.
- Truncated / missing thread id → parse refuses (no spawn, no keys).
- Missing `run`, extra tokens that break the line, or a lookalike without `whistlr.decision` → not a marked card (unmarked key path).
- `run` is parsed for the contract but is **not** a `whistlr reply` argv flag.

qid / answer mapping for `whistlr.decision_response.v1`:

```json
{ "answers": { "<qid>": "<option id or text>" }, "notes"?: "..." }
```

- Single-question marked cards use qid `"q1"` unless the lifted card already exposes a question id — do not invent extra qids.
- Answer value is the selected option's id if present (`keyLabel`, else the option digit in `keys`), otherwise the option `label`.
- `notes` is omitted unless the operator typed notes on this pick (current prompt-select option tap has none — omit).

## Do

On operator pick of a marked card: spawn

```
whistlr reply --thread <id> --payload <json> --schema whistlr.decision_response.v1
```

(31C already shipped this.) Do **not** `sendKeys` / `sendGuardedKeys` for marked cards.

Real harness AskUserQuestion / `ask_user_question` / pi dialog **without** the marker: existing key path only.

If 31F's claude/grok/pi ASCII does not lift today, add the **smallest** parser change so it does, then the bridge. If that would be a new grammar family, **stop** — do not add a family; leave a failing note in the implementation summary. Tolerating the marker line inside the existing prompt-select / grok-ask / pi-ask scans is not a new family.

`WHISTLR_STATE_DIR` / `WHISTLR_CONFIG_DIR` stay `%USERPROFILE%\.whistlr`. Do not open whistlr's database. Do not add a new MCP server or a `whistlr_ask` tool. Do not auto-write draftr envelopes or skip draftr phases.

## Files to touch

Builder writes for this run are `web/src/`, `bridge/`, `shared/`, `docs/`, `CHANGELOG.md`. Do not edit `draftr.toml`, `.github/`, `.gitignore`, `.env`. Do not edit draftr or whistlr sources.

### Bridge (tests live here so `bun run test` runs them)

- `bridge/decision-marker.ts` — pure parse of the marker line / lifted region → `{ thread, run }` or refuse. No I/O.
- `bridge/decision-payload.ts` — pure `{ answers: { q1: <option id or text> } }` builder. No I/O.
- `bridge/decision-reply.ts` — spawn `whistlr` with injectable runner (default `Bun.spawn`). Argv exactly `--thread`, `--payload` (JSON string), `--schema whistlr.decision_response.v1`. Never calls pane key APIs.
- `bridge/decision-reply.test.ts` — the five required tests (mock spawn; no live pane, live sightr, or live whistlr broker).
- `bridge/decision-reply-routes.ts` (or a tightly scoped addition in `bridge/pane-write-routes.ts`) — write-gated POST that accepts the lifted region + selected option (or pre-parsed thread + answer), parses, spawns, returns `{ ok: true }` / error. Must not call `herdr.sendPaneKeys` / `sendReplySteps`.
- `bridge/server.ts` — register the route next to existing pane write actions; same write `guard` as `/keys`. Extend `PANE_ROUTE` (or add a sibling) rather than a new MCP surface.

Suggested route: `POST /api/pane/:paneId/decision-reply` with JSON body carrying the lifted card text (question + option labels is enough if the marker is in `question`; include `signature` / raw region when the marker is the last kept line) and the selected option `{ keyLabel?, keys, label }`. Pane id is for auth/audit only — do not type into it.

### Shared

- `shared/wire.ts` — request/response types for the route (`DecisionReplyRequest` / reuse `ActionResponse`). Keep the HTTP contract here so the web client does not invent a second shape.

### Web (call the helper or the route; do not spawn whistlr in the browser)

- `web/src/lib/api.ts` — `decisionReply(paneId, body)` POST to the new route. Same lock / XHR headers as other pane writes.
- `web/src/lib/actions.ts` — `submitPromptOption`: if the prompt is marked, POST decision-reply and **return without** `sendGuardedKeys` / `sendKeys`. Unmarked path unchanged. Feedback / wizard / multi-select / preview / menu: unchanged (keys only).
- `web/src/lib/harness/prompt-model.ts` — optional `decision?: { thread: string; run: string }` on `PromptModel` so the tap path does not re-scan the whole buffer. Identity comparators must still treat unmarked vs marked as different if the marker is part of `question` / `coreSignature` (existing string compare is enough; do not special-case).
- `web/src/hooks/use-pane-view.ts` — only if the marked branch cannot live entirely in `submitPromptOption`. Prefer keeping the branch in `actions.ts`.
- `web/src/lib/harness/claude/prompt-select.ts`, `web/src/lib/harness/grok/ask.ts`, `web/src/lib/harness/pi/ask.ts` — **only** if fixtures with the marker do not lift today. Smallest change:
  - Claude: `classifyFooter` fails if the marker is the last non-blank line — skip a trailing marker and classify the line above; if the marker sits on/under the question, keep it in `question` or in the region already copied into `signature`. Question scan still requires `?` on the real question line.
  - Grok: unclassified gutter lines above options currently become `question` and overwrite; do not let the marker replace the question. Stash a matching marker line onto the model. Footer still has to be the existing ask footer.
  - Pi: question rows are the spaced lines above options; if the marker is one of those lines, keep it (append to `question` or set `decision`) rather than failing the leading-space / rule walk. Do not add a new Pi widget.
- Do not change wizard / multi-select / preview detectors for this slice. Marked cards in this run are single-choice prompt-select lifts.

Bridge tests may import the web detectors only if that stays cheap; otherwise keep lift fixtures in `bridge/decision-reply.test.ts` as raw strings and assert parse + argv + “no key send”. Web vitest is **not** required for `bun run test`.

### Docs / changelog

- `CHANGELOG.md` — add `## [Unreleased]` above `## [1.0.5]` with a short Added note: marked draftr operator-decision cards submit `whistlr reply --payload` and do not type into the pane.
- `docs/whistlr-31f-sightr.md` — this file. Builder may append a short “shipped” paragraph under a `## Shipped` heading. Do not add CONTEXT/DECISIONS files. Do not invent other docs.

## Behaviour

1. Phone tap on a marked prompt-select option → bridge spawns `whistlr reply` with `--thread`, `--payload`, `--schema whistlr.decision_response.v1`.
2. That tap does not call `sendGuardedKeys` / `sendKeys` / `sendBoundKeys` / `herdr.sendPaneKeys`.
3. Unmarked prompt-select (and every other existing dialog) still sends keys only; no whistlr spawn.
4. Marker parse refuse (truncated / missing thread) → no spawn, no keys; surface the existing `{ status: "changed" | "error" }` style failure so the UI refreshes instead of typing.
5. Spawn is mocked in tests. Production spawn is the `whistlr` binary on PATH. Do not point it at a whistlr checkout. Do not read `%USERPROFILE%\.whistlr`.

## Tests (`bridge/decision-reply.test.ts`)

`bun test` (repo root) green. Cover:

1. Marked grok-shaped card → pick option → `whistlr reply` argv has `--thread`, `--payload`, `--schema whistlr.decision_response.v1`; no key send.
2. Marked claude-shaped card → same.
3. Unmarked prompt-select → keys only; no whistlr spawn.
4. Marker parse refuses a truncated / missing thread id (no spawn).
5. Payload maps the selected option id/label onto `answers`.

Mock spawn; do not require a live pane, live sightr, or live whistlr broker.

Also keep `bun run typecheck` green (it is part of `bun run test`).

## Done means

- Marked card pick posts `whistlr reply --payload` and does not type into the pane.
- Unmarked harness cards unchanged.
- Root `bun run test` green.
- draftr 31F remains a later slice (add the marker + production map there). Do not start it from this run.

## Do not

- Touch draftr or whistlr sources. Do not resume `5a81defb`.
- Send keys to the pane for marked decision cards.
- Auto-write draftr envelopes or skip draftr phases.
- Start Jev. Do not implement 33. Do not re-run pack 03.
- Add a new MCP server or a `whistlr_ask` tool.
- Edit git.protected files (`draftr.toml`, `.github/`, `.gitignore`, `.env`). Do not `git push --tags`.
- Chain a second sdlc back onto draftr from this request.
- Create a new dialog grammar family.
- Change `WHISTLR_STATE_DIR` / `WHISTLR_CONFIG_DIR`.
