# T08 — Capability flags and live mode switches

Status: draft (T3-shape series). Depends on: T01, T02 (interim capability table), T04 (open requests), T05, T06 (guarded sender, interrupt rows), T07 (`launch` in `shared/agents.ts`).

## Problem

T3 lets the user change model, effort and permission mode in the composer. Sightr's harnesses differ: Claude cycles
permission modes with `shift+tab` and takes `/model <id>`; Pi has `/model` as a picker only; Cursor shows
"Plan (shift+tab to cycle)"; Agy and Codex are less clear. Today the web app branches on the agent id in several
places. The v2 UI must not. It reads flags, and the bridge refuses commands the harness cannot do.

## Change

### Capability flags (`shared/agents.ts`)

Add `capabilities` to `AgentDescriptor`, typed as T01's `ThreadCapabilities` (`shared/v2/contracts.ts`). This slice
owns the names; T01 lists the same set:

```ts
interface ThreadCapabilities {
  canInterrupt: boolean;
  interruptKeys?: readonly string[];        // consumed by T06
  canQueueDrain: boolean;                   // has a composer kit; false for a plain shell
  canSwitchPermissionMode: boolean;
  permissionModes?: readonly string[];      // ids as in launch.modes
  canSwitchModel: boolean;
  modelCommand?: string;                    // e.g. "/model"; present only when it takes an argument
  canSetEffortLive: boolean;
  effortCommand?: string;                   // e.g. "/effort"
  hasJournal: boolean;
  resumeBySession: boolean;                 // used by the later archived-thread resume; no action here
  launchModes: boolean;                     // launch args exist (T07)
}
```

`hasJournal` is derived from `journal !== undefined` so the two cannot disagree; a test pins it. A helper
`capabilitiesFor(agent)` returns the record or a shell record (everything false). Threads copy it into
`Thread.capabilities` at creation (T01 already names the field). This replaces T02's interim table: the interrupt
rows T06 added there move here unchanged, and `bridge/threads/capabilities.ts` becomes a re-export. There is no
steer flag; the UI and T06 treat steer as `canInterrupt && canQueueDrain`.

First table. "unverified" means the behaviour was not exercised on this machine.

| id | interrupt | permission mode live | model live | effort live | journal | resume by session |
|---|---|---|---|---|---|---|
| claude | `Escape` (unverified) | yes: `shift+tab` cycle | yes: `/model <id>` (catalog: takes arg) | yes: `/effort <level>` (catalog) | yes | yes |
| pi | `Escape` (unverified) | no | no: `/model` is picker-only (catalog `takesArg: false`) | no | yes | yes |
| grok | `Escape` (unverified) | `shift+tab` per its footer hint "Shift+Tab:mode"; cycle order unverified | unverified (catalog empty) | unverified | yes | yes |
| cursor | `ctrl+c` | `shift+tab` per its mode line "(shift+tab to cycle)"; unverified end to end | yes: `/model <model>` (catalog) | no | yes | unverified |
| agy | `Escape` (unverified) | unverified | unverified | unverified | no | unverified |
| codex | `Escape` (unverified) | unverified | unverified | unverified | no until T16 | yes (herdr reports `agent_session` kind `id`) |

Any "unverified" cell ships as `false` until a live check is recorded. A false flag only hides a control; it never
blocks a user from typing the slash command in the composer.

### Mode detection (`web/src/lib/harness/*/chrome.ts`, `composer-kit.ts`)

Cycling needs to know the current mode. Add to `ComposerKit` (and so to the identity test against the adapters):

- `permissionModeOf(text: string): string | null` — reads the footer rows of an ANSI read and returns a mode id from
  `permissionModes`, or `null` when it cannot tell.

Per harness, in the existing leaf chrome files so the import closure stays free of `react` and `@shared`:

- **claude** (`claude/chrome.ts`): the hint row below the input box. The chrome file already notes rows such as
  "⏵⏵ bypass permissions on …". The exact strings for `acceptEdits`, `plan` and `auto` are unverified; capture them
  into fixtures first and write the matcher from the fixtures. Default mode shows no mode text.
- **grok** (`grok/chrome.ts`): the statusline's optional permission-mode word (`extractStatusLines`).
- **cursor** (`cursor/chrome.ts`): the optional mode line above the status rows.
- Others: not implemented; `permissionModeOf` is absent and the flag is false.

A `null` result for a harness whose default mode prints nothing (Claude's default) is treated as the id
`default` only if the kit says so (`defaultModeId`); otherwise it is unknown and the switch refuses.

### Command: `thread.permissionMode.set {threadId, mode, confirmBypass?}`

Runs inside the pane write queue. It needs the thread to be settled (`idle` or `done`), because shift+tab during a
tool run or a dialog is ambiguous.

1. Refuse if `!canSwitchPermissionMode` (`unsupported`), mode not in `permissionModes` (`invalid-mode`), thread not
   settled (`thread-busy`), or the thread has an open runtime request (`needs-response`).
2. `bypassPermissions` requires `confirmBypass`. Cycling through it on the way to another mode is allowed, since
   Claude's cycle includes it only when enabled; see step 4.
3. Read the pane. `composerReady` must hold (else `blocked`, nothing sent). Read the current mode with
   `permissionModeOf`. `null` means `unknown-mode`, nothing sent. Equal to the target: succeed, send nothing.
4. Press the cycle key (`shift+tab` via `sendKeysPaced`), settle 250 ms, re-read, repeat. Stop when the footer shows the
   target. Give up after `MAX_PRESSES = 6` (more than the longest known cycle) with `mode-not-reached`, and report the
   mode the footer shows. Because the pass-through modes can be dangerous, the loop aborts the moment the footer shows
   `bypassPermissions` unless it is the target: it stops there and reports it. (Claude only reaches bypass in the
   cycle when it was launched with `--allow-dangerously-skip-permissions`; unverified.)
5. Emit `thread.updated {permissionMode}` on success. Otherwise append `command.rejected {reason, shown}` (T05's
   rule for a rejection found after work started). The projection stores `permissionMode` from the last confirmed read.

The re-read after each press goes through the same `herdr.readPane(..., "ansi")` call as the guard, so no extra
adapter is needed.

### Command: `thread.model.set {threadId, model}`

Only for harnesses with `canSwitchModel` and a `modelCommand`. The command type text is `${modelCommand} ${model}`.
It goes through the guarded send core (`start` path from T06), not around it, so the composer guard applies. The model
string must match `/^[A-Za-z0-9._:\/-]{1,80}$/`; anything else is `invalid-model`. Refused when the thread is not
settled. Success is the guarded send's `sent`. The harness's own confirmation is not parsed (unverified for every
harness); the UI shows "Requested" and the thread's `model` field updates only from a later source (a journal
`model` field, where the adapter has one). If the screen shows a picker after the send (Pi), the request ingestor (T04)
emits it as a runtime request; the user answers it there.

`thread.effort.set` is out of this slice; `canSetEffortLive` only reserves the flag.

### UI rule

`web2` reads `thread.capabilities` only. `agent ===`, `harness ===`, and switch statements on ids are banned in
`web2/src` by a lint-style test (grep for ids in `web2/src/**/*.tsx` outside the harness-icon map). The existing
`web/` keeps its branches until cutover.

## Invariants

- No switch while the thread is working, blocked, or has an open request.
- No key goes out unless a read just showed the composer.
- The cycle loop never lands on or passes `bypassPermissions` without `confirmBypass` and an explicit target.
- Unverified flags are `false`.
- Model switching reuses the guarded send; nothing types around the guard.

## Tests

- `capabilitiesFor` for each descriptor matches the table; `hasJournal` equals `journal !== undefined`; a shell record is all false.
- Kit identity test: `permissionModeOf` on the kit is `===` the adapter's.
- `permissionModeOf` fixtures per harness (captured from live panes; the spec cannot list them yet) plus a null case.
- `permissionMode.set` with a fake Herdr whose screen advances one mode per `shift+tab`:
  reaches the target in N presses; already there sends nothing; gives up after 6; aborts on an unrequested bypass;
  `unknown-mode` when the footer is unreadable; refuses working, blocked and unsupported threads; no keys when no composer.
- `model.set`: types `/model <id>` through the guarded send; refuses a bad id, an unsupported harness, a busy thread.
- Lint test: no harness id literals in `web2/src` outside the icon map.
- Live (scratch workspace): Claude mode cycle and `/model`; Cursor `/model`; others recorded as not live-tested or unverified.

## Notes for the planner

- Claude's cycle contents depend on launch flags and on the account (auto mode needs enablement). Targets that never
  appear produce `mode-not-reached`; the UI should list only modes seen as launchable.
- Pi's `/model` takes no argument in the catalog, so Pi has `canSwitchModel: false` even though a picker exists.
- `cursor-agent` and `codex` were not runnable from the drafting shell, so their rows rest on code and catalogs only.
