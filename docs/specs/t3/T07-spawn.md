# T07 — Spawn a thread

Status: done on feat/v2 (2026-10-16). Depends on: T01, T02 (thread ingest, interim capability table), T05 (command endpoint; owns the herdr >= 0.9.0 start-up check and the 503). T08 lands after this slice and adds `capabilities` beside `launch` in `shared/agents.ts`.

## Problem

Sightr can create a shell tab (`createTab` in `bridge/tree-routes.ts`) or a workspace, but the user then has to type
`claude --model …` into it by hand. T3's "New thread" picks a project, a harness, a model and a mode and starts
the agent. Herdr 0.9.0-preview has `agent.start {name, kind, pane_id, args, timeout_ms}` which starts a supported
agent in an existing pane at its shell prompt and returns when the agent is detected and ready. Sightr should use it.

## Change

### Herdr client (`bridge/herdr-client.ts`)

Already wrapped: `createTab(workspaceId, {label?, cwd?})` (`tab.create`, `focus:false`), `createWorkspace({cwd, label?})`
(`workspace.create`), `closePane`, `readPane`, `renamePane`. New wrappers, all in this file because it is the only
place that knows method names:

- `splitPane(opts: {targetPaneId?: string; workspaceId?: string; direction: "right" | "down"; cwd?: string}): Promise<CreatedShell>`
  — `pane.split` (schema: `direction` right|down, `target_pane_id`, `workspace_id`, `cwd`, `focus` default false; always send `focus:false`).
  The reply shape is unverified; read it from a live call and decode defensively (`pane` or `root_pane`).
- `startAgent(opts: {paneId: string; name: string; kind: string; args: string[]; timeoutMs?: number}): Promise<void>`
  — `agent.start`. `timeout_ms` must be above 3000 and at most 300000 (schema). Default 30000 (the CLI's default).
- Not needed: `agent.prompt` and `agent.wait`. The first message goes through T06's guarded send, which has the
  composer guard; `agent.prompt` does not.

`herdrErrorCode` already extracts the code from a thrown error. The codes `agent.start` returns are unverified. The
route maps the known ones in a table and treats the rest as `spawn-failed` with the herdr message.

### Launch table (`shared/agents.ts`)

Add a `launch` field to `AgentDescriptor`. It holds only data; no Node APIs, so the browser can show the pickers.
This slice also adds a `codex` descriptor (id, label, `launch`, no `journal`; T16 adds the journal), since Codex has
no entry in `AGENTS` today.

```ts
interface LaunchSpec {
  kind: string;                         // herdr `--kind`
  models?: readonly { id: string; label: string }[];   // suggestions only; free text allowed
  modelArg?: readonly string[];         // e.g. ["--model"]
  effortArg?: readonly string[];
  efforts?: readonly string[];
  modeArg?: readonly string[];
  modes?: readonly { id: string; label: string; value: string; destructive?: boolean }[];
}
```

`buildLaunchArgs(agent, {model?, effort?, permissionMode?})` is a pure function in `shared/agents.ts`. It returns
`string[]`. An unknown model/effort/mode value is rejected, not passed through, unless it matches
`/^[A-Za-z0-9._:\/-]{1,80}$/` (models only). Arguments are an array, never a shell string, so there is no injection.

First table (corrects T3-shape README open question 3):

| id | herdr kind | model | effort | permission mode |
|---|---|---|---|---|
| claude | `claude` | `--model <alias or id>` (aliases such as `opus`, `sonnet` per `claude --help`) | `--effort low\|medium\|high\|xhigh\|max` | `--permission-mode manual\|acceptEdits\|auto\|plan\|dontAsk\|bypassPermissions` |
| pi | `pi` | `--model <pattern>` | `--thinking off\|minimal\|low\|medium\|high\|xhigh\|max` | none (plan mode is an extension flag) |
| grok | `grok` | `-m <id>` | `--effort <level>` (alias of `--reasoning-effort`; level list unverified) | `--permission-mode default\|acceptEdits\|auto\|dontAsk\|bypassPermissions\|plan` |
| agy | `agy` | `--model <id>` | `--effort low\|medium\|high\|xhigh\|max` | `--mode accept-edits\|auto\|plan` |
| cursor | `cursor` | unverified (`--model` is expected) | none | unverified |
| codex | `codex` | unverified (codex is not installed here) | unverified | unverified |

Confirmed with `claude --help`, `pi --help`, `grok --help`, `agy --help` on this machine. `cursor-agent` and `codex`
could not be run from this shell, so every Cursor and Codex flag is unverified and those two ship with empty
`modelArg`/`modeArg` until someone checks. `bypassPermissions` is `destructive: true`; the UI asks twice, and the
bridge refuses it unless the request says `confirmBypass: true`.

### Command: `thread.create`

```
thread.create {
  projectId | newProject: {cwd, label?},
  harness, model?, permissionMode?, effort?,
  placement: "tab" | "split",
  splitFrom?: threadId, direction?: "right" | "down",
  name?, confirmBypass?
}
```

The handler runs in this order:

1. Validate. `harness` must be in `AGENTS` with a `launch`. Build args with `buildLaunchArgs`; a bad value is a
   `400`-style `invalid-launch` before any pane exists. Herdr below 0.9.0 is T05's gate; this handler does not re-check.
2. Resolve the project. `newProject` first runs `project.create` (below) and uses its root pane. Otherwise find
   the workspace by `projectId`; unknown is `no-such-project`.
3. Make the pane. `tab`: `herdr.createTab(workspaceId, {label: name, cwd?})` (`cwd` defaults to the workspace's).
   `split`: `herdr.splitPane({targetPaneId: from.paneId, direction})`. Emit nothing yet.
4. Emit `thread.created {status: "starting", harness, projectId, paneId, terminalId?, capabilities}` (from
   `capabilitiesFor(harness)`, T02) as soon as the pane
   exists. This is early on purpose: the sidebar shows the row while the agent boots. T02's ingest sees the same pane
   in the next snapshot and must adopt the `starting` thread by `paneId` instead of creating a second one (see Notes).
   The `terminalId` is filled in by T02's first poll.
5. Wait for the shell prompt. Poll `readPane(paneId, "recent", 20)` every 250 ms for up to 10 s until the last
   non-blank line is non-empty and unchanged for two reads. The pane is also checked in the snapshot (`kind: shell`).
6. `herdr.startAgent({paneId, name: name ?? defaultName, kind, args, timeoutMs: 45_000})`. `agent.start` itself
   waits until the agent is detected and ready. If it replies that the pane is not at a prompt, retry up to 3 times,
   1 s apart (error code unverified: match on code, then on message text as a fallback).
7. Success: emit `thread.updated {status: "idle"}`. T02 then owns the thread. The reply to the command was already
   `{sequence}` at step 4; success or failure of the rest arrives as events.
8. Failure: emit `thread.create.failed {threadId, stage: "pane" | "prompt" | "agent", message}`, a `system_notice`
   item with the message, and `thread.archived` with `archiveReason: "spawn-failed"`.
   - If **we created the pane** (always true for `tab` and `split`) and `startAgent` failed: `closePane(paneId)`
     — but only after a read confirms the pane still shows no agent (snapshot `agent` is null) and its
     `terminal_id` equals the one seen at creation. If that check fails, leave the pane, since the user may have taken it over.
   - `newProject` where the workspace was created by this command and then failed: close the workspace only if it
     still has exactly one pane and one tab.
   - Never close a pane this command did not create.
9. Timeout (`agent.start` returns after `timeoutMs` with an error): same as failure, `stage: "agent"`, message
   "The agent did not start in 45 s". The UI offers "Open terminal" because the pane may still be starting; for that
   case the pane is left in place (a slow cold start is common), and the thread stays `starting` until T02 sees an agent
   or the user archives it. Only a hard error closes the pane.

### Command: `project.create {cwd, label?}`

`herdr.createWorkspace({cwd, label})`, which already exists. Validate `cwd` with `bridge/containment.ts` the way
`createWorkspace` in `tree-routes.ts` does today (home default when omitted is not used: v2 requires a cwd). The new
workspace's root pane is a shell and is not a thread by itself; `thread.create` with `newProject` uses it.
Emits `project.upserted` (T01's name). The client finds the new project by the event's `commandId`.

### Names

`name` defaults to `<harness> <n>` where `n` counts live threads of that harness in the project. Herdr agent names
are unique per herd (unverified); on a name clash, append ` 2`, ` 3`.

## Invariants

- The launch args are an array built from a table, never a string from the client.
- `bypassPermissions` needs `confirmBypass`.
- A pane we did not create is never closed. A pane we did create is closed only on a hard `agent.start` error
  that left it without an agent.
- `thread.created` is emitted once per command; a retry with the same `commandId` returns the same thread.
- The first message is sent by T06, not by spawn.

## Tests

- `buildLaunchArgs`: each harness x model/effort/mode; unknown mode rejected; model pattern rejected; no mode for Pi;
  `bypassPermissions` flagged.
- Herdr client: `splitPane` and `startAgent` send the right params (fake socket); `timeout_ms` below 3001 clamps.
- Handler with a fake Herdr:
  - tab path: createTab, prompt poll, startAgent with kind and args, then idle.
  - split path calls `pane.split` with `focus:false`.
  - `thread.created` is emitted before `startAgent` resolves.
  - prompt never appears: `thread.create.failed stage:"prompt"` and the pane is closed.
  - `startAgent` hard error: pane closed only when the snapshot shows no agent and the terminal id matches; otherwise left.
  - `startAgent` timeout leaves the pane and the thread `starting`.
  - `newProject` creates the workspace, uses its root pane; a failed start closes the workspace only if it is empty.
  - replay of the same `commandId` makes one pane.
  - bypass without `confirmBypass` is refused with no pane created.
  - never closes a pane it did not create (a pre-existing pane id passed in `splitFrom` stays).
- T02 interplay: a `starting` thread is adopted by paneId, with no duplicate row.
- Live, in a scratch workspace: tab and split for Claude and Pi; Grok, Agy and Cursor only if signed in. Record the rest as not live-tested.

## Notes for the planner

- `herdr agent start --help` states the pane must be at an interactive shell prompt, and "success means the expected
  agent was detected in the same terminal and is ready for input." Whether Windows PowerShell panes report "at prompt"
  quickly is unverified.
- The `pane.split` reply shape and the `agent.start` error codes are unverified; the schema gives request params only.
- Herdr's kind list also holds `gemini`, `opencode`, etc. The table covers only the six Sightr has adapters for.
- T3 README line "herdr too old → refuse" is handled once, by T05's gate; this spec has no separate path.

## Built

`bridge/threads/spawn.ts` (`createSpawner`: `thread.create` and `project.create` as T05 effects, wired in
`bridge/index.ts`), the launch table and `buildLaunchArgs` in `shared/agents.ts`, `splitPane` / `startAgent` /
`getPane` in `bridge/herdr-client.ts`. Tests: `bridge/threads/spawn.test.ts`, `bridge/herdr-client.test.ts`.
Live on 16 Oct 2026 (herdr 0.9.0-preview.2026-09-16) in a scratch workspace made by `project.create`: Claude
(Haiku) in a tab and pi (thinking low) as a split both started; Grok, Agy and Cursor were not live-tested.

Deviations:

- `agent.start` over the socket does not wait. It types the launch command and answers at once; the herdr CLI
  does the waiting by polling `agent.get` (`src/cli/agent.rs`). `HerdrClient.startAgent` does the same: ready is
  `idle`/`done` with `interactive_ready`; a `blocked` agent (a start-up dialog such as folder trust) counts as
  started, because T04 answers those (the CLI calls that "not ready"). Wait failures use the CLI's codes:
  `timeout`, `agent_start_failed`, `agent_kind_mismatch`, `agent_name_not_found`.
- Known codes (from the herdr source): `agent_pane_busy` (not at a prompt; retried 3 times, 1 s apart),
  `agent_name_taken` (retried with `-2`, `-3`, …), `invalid_agent_name`, `unsupported_agent_kind`,
  `invalid_agent_argument`, `agent_pane_not_found`, `agent_pane_unavailable`. The operator sees a sentence per
  code; an unknown code reads `spawn-failed: <herdr message>`.
- herdr agent names must match `[a-z][a-z0-9_-]{0,31}`, so the default name is `<harness>-<n>` (not
  `<harness> <n>`), and a given `name` is slugged for herdr while the thread keeps it as a `user` title.
- herdr returns `terminal_id` on every created pane (`tab.create`, `workspace.create`, and `pane.split`, whose reply
  is `{type: "pane_info", pane}`), so `thread.created` carries the terminal at once. If the herd ingest listed the
  pane first, the spawn takes that thread over with `thread.updated` instead of creating a second one.
- A failure to make the pane is the command's own error (502 `failed`, no receipt): no thread exists yet, so
  there is no `thread.create.failed {stage: "pane"}`.
- After a hard failure the thread is archived (`spawn-failed`) only when its pane was closed or is gone. A pane
  left in place (it holds an agent, or its terminal changed) keeps a live thread, set back to `idle` for the herd
  ingest; archiving it would hide that pane from v2, since the ingest never revives a `spawn-failed` thread.
- On success the spawn pokes the engine and waits up to 3 s for the snapshot to show the agent; it sets `idle`
  only if the thread is still `starting`. Live, herdr marks the pane as an agent as soon as `agent.start` types
  the command, so the herd ingest ends `starting` about 1 s after the pane appears, before the agent is ready.
- The prompt wait reads `visible` (not `recent`) 20 lines: a visible read never scrolls a pane.
- `project.create` checks that `cwd` is an absolute, existing local directory (real path, no UNC). There is no
  root to contain it in (v1's `createWorkspace` does no check), so `containment.ts` is not used.
- `newProject` uses the new workspace's root pane; `placement` is ignored. A split takes its project from
  `splitFrom`; `projectId` is optional there.
- Herd ingest (T02): a `starting` thread whose pane is still a bare shell keeps its status, harness, title and
  capabilities; the missing-pane grace now covers any `starting` thread, not only one with no terminal yet.
- `buildLaunchArgs` returns `{ok, args, destructive}` or `{ok: false, reason}`. A free-text model must also start
  with a letter or digit, so it cannot read as a flag. Grok's `--effort` is left out: its help lists no levels.
  Codex joins `AGENTS` with `catalog: []` (the web tables need it) and no journal.
- Live notes: `codex` is not installed here; its spawn timed out after 45 s with the pane left and the thread
  `starting` (step 9). pi with an unknown model was reported ready by herdr, then exited; the thread became a
  shell thread with no failure event. The hard-failure clean-up is covered by tests only.
