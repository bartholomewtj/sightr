# T16 — Codex journal adapter

Status: done on feat/v2 (2026-10-17). Depends on: T03 (journal ingest consumes adapters). No dependency on T06 to T08, but T08's capability table flips Codex `hasJournal` when this lands.

## Problem

Codex panes get a thread, status, runtime requests, queue and steer, but no timeline: `shared/agents.ts` has no
`codex` descriptor and `bridge/journal/registry.ts` has no Codex adapter. Their thread shows only what Sightr sent
plus a `screen` item per run (T3-shape README, "Ingest"). Herdr reports a Codex pane's `agent_session` with kind `id`
(the rollout's session uuid), so the pieces to find the log exist; only the reader is missing.

## What was and was not verified

Codex is not installed on the drafting machine or the build machine, and was not installed for this slice. **No
rollout file was read.** At build time the layout and record shapes were instead **derived from the Codex source at
github.com/openai/codex commit `4eb4a65407d98cebc4c83bf13be440b9fbc78a7c` (16 Oct 2026), not captured live**:
`codex-rs/history/src/lib.rs` and `rollout_payload.rs` (RolloutLine, RolloutItem), `codex-rs/protocol/src/models.rs`
(ResponseItem, ContentItem, FunctionCallOutputPayload), `codex-rs/rollout/src/{rollout_file_name,list,policy,
compression,recorder,ordinal}.rs` (file names, lookup, what is persisted, `.zst`, timestamps, ordinals),
`codex-rs/core/src/tools/{mod,context}.rs` (exec output text) and `codex-rs/core/src/context/` (injected user
fragments). How herdr names the session was read from herdr's own Codex hook (`tmp/herdr-src`,
`src/integration/assets/codex/herdr-agent-state.sh`): it reports the hook's `session_id` (else `CODEX_THREAD_ID`) as a
kind-`id` ref, which is the thread uuid in the rollout filename. The fixtures use those shapes with invented text. The
first live Codex session should be checked against them (see "Built").

## Change

### Descriptor (`shared/agents.ts`)

T07 adds a `codex` entry with `launch` and no `journal`. Add the `journal` field to it (the whole entry, if T07 has
not landed):

```ts
{ id: "codex", family: "codex", prefixes: ["codex"], label: "Codex CLI", catalog: [],
  journal: { rootEnv: "SIGHTR_CODEX_ROOT", homeEnv: "CODEX_HOME", homeDefault: [".codex"], subdir: ["sessions"] } }
```

`bridge/config.ts` already builds `roots[agent.id]` from the descriptor (`rootEnv`, `homeEnv`, `homeDefault`,
`subdir`), so `SIGHTR_CODEX_ROOT` and `CODEX_HOME` work with no config change. `bridge/config.test.ts` already
checks every `rootEnv` against its docs; add the variable to the same list it reads. The entry order in `AGENTS`
is unchanged for existing ids. A brand tile is optional (use the neutral text tile pattern).

### Adapter (`bridge/journal/codex.ts`, new)

Exports, mirroring `pi.ts` and `cursor.ts`:

- `isCodexSessionId(value: string): boolean` — a uuid (v4 or v7 shape), validated before it touches a path.
- `parseCodexTranscript(text: string): TranscriptEntry[]` — pure.
- `class CodexTranscriptSource implements TranscriptSource`.
- `codexJournal(roots: string | readonly string[]): JournalAdapter` with `agent: "codex"`.

**Locating the file** (`resolve(ref)`). Only `kind: "id"` refs are accepted; a `path` ref is refused (Codex does not
report one). Rollouts live under `<root>/YYYY/MM/DD/rollout-<local timestamp>-<session uuid>.jsonl` (unverified).
The resolver:

1. validates the id with `isCodexSessionId`;
2. for each root from `rootList(roots)`, lists the year/month/day directories newest first and looks for a file whose
   name ends `-<id>.jsonl`; it never builds a path from the id alone, only matches names it listed;
3. caps the walk (at most 366 day directories per root, newest first) so a deep tree cannot stall the bridge; a miss is
   `null`, which the route reports as `no-log`;
4. re-checks the result with `containedRealpath` against the root it came through (`files.ts`), per the rule in that file.

`stat` is `statFile`; `load` is `loadTail` (32 MB cap, newest end kept, as for every adapter).

**Record shapes** (from source, see above; the draft's guesses held except where "Built" says otherwise). Each line
is `{"timestamp":"…Z","ordinal"?:n,"type":"…","payload":{…}}`; `ordinal` appears only in paginated rollouts:

| Record | Mapping to `TranscriptEntry` |
|---|---|
| `session_meta` (first line: id, cwd, cli version) | skipped; ignored by `parse` |
| `response_item` with payload `type: "message"`, `role: "user"` | `role: "user"`, one `text` part from the `input_text` content items |
| `response_item` `message` with `role: "assistant"` | `role: "assistant"`, `text` parts from `output_text` items |
| `response_item` `reasoning` | `thinking` part from the summary text; empty or encrypted-only reasoning is dropped |
| `response_item` `function_call` / `custom_tool_call` (name, arguments, call id) | `tool` part on the assistant entry: `name`, `summary` from the arguments (a shell command line for the shell tool, else the first argument value, one line, 160 chars), no result yet |
| `response_item` `function_call_output` (call id, output) | attached as `result` to the tool part with the same call id; `isError` when the output says non-zero exit (unverified field) |
| `event_msg` kinds (user_message, agent_message, token_count, task_started, …) | ignored: they duplicate `response_item` rows. Exception: if a harness version records only `event_msg` for a turn, the fixtures will show it and the builder adds a fallback |
| `turn_context` | ignored |
| anything unknown, or an unparseable line | skipped, never thrown (a clipped first line is expected under the byte cap) |

Rules shared with the other adapters:

- `uuid` must be stable across re-parses and unique: use the record's own id when it has one (call id for tools), else
  `<line index in the full file>`-based ids are not stable under tail-clipping, so use a hash of
  `timestamp + type + first 64 chars of the text` plus a counter for collisions. T03 builds item ids as `uuid + part index`
  and relies on this.
- Consecutive assistant records (text, reasoning, tool calls) between two user messages merge into one assistant entry
  with several parts, as Claude's and Pi's adapters do, so a turn reads as one block.
- Text of injected context (environment/system preamble sent as a user-role message) must not render as a user turn.
  Codex puts such blocks in user-role messages (unverified); skip a user message whose text starts with a known
  wrapper tag (`<environment_context>`, `<user_instructions>`; unverified names) and list the skipped prefixes in one
  constant the fixtures test.
- Long tool output is truncated with `truncated: true` using the same limits as `pi.ts` (reuse `text.ts` helpers).

### Registry (`bridge/journal/registry.ts`)

Add `codexJournal(roots.codex ?? [])` to the adapters list. `JournalRoots` is `Partial<Record<AgentId, …>>`, so the
new id is accepted once the descriptor exists. `registry.test.ts` gains `codex` in its expected agents.

### Thread capabilities

`hasJournal` for Codex is derived from the descriptor (T08), so T03 starts tailing Codex threads with no further change.
`resumeBySession` stays as T08 set it.

## Invariants

- The id is validated and the file is matched by listing, never by concatenating the id into a path.
- Every resolved path passes `containedRealpath` for the root it was found under.
- `SIGHTR_TRANSCRIPT=off` disables Codex like every other journal.
- `parse` is pure and never throws on malformed lines.
- No real conversation text is committed; fixtures use invented content.

## Tests

- `isCodexSessionId`: v4, v7, traversal attempt, empty, too long.
- `parseCodexTranscript` on fixture files (`bridge/journal/fixtures/codex-*.jsonl`, invented content, shapes taken
  from a live capture):
  - user then assistant text;
  - reasoning summary becomes `thinking`; empty reasoning is dropped;
  - a tool call with its output merges into one `tool` part with a result;
  - a tool call with no output yet has no result;
  - a failing tool output sets `isError`;
  - injected-context user message is skipped;
  - consecutive assistant records merge into one entry;
  - unknown record types and garbage lines are skipped;
  - a clipped first line is skipped;
  - ids are stable when the same text is parsed twice and when the head is clipped.
- `CodexTranscriptSource` with a temp tree:
  - finds `YYYY/MM/DD/rollout-…-<id>.jsonl`;
  - misses return `null`;
  - a `path` ref returns `null`;
  - a symlinked day directory pointing outside the root is refused (skipped where `CAN_SYMLINK` is false, as in `pi.test.ts`);
  - walk cap holds on a tree with more than 366 day folders;
  - two roots: first holding the session wins.
- `registry.test.ts`: `adapterFor(registry, "codex")` returns the adapter; `journalAgents` lists it.
- `config.test.ts`: `SIGHTR_CODEX_ROOT` and `CODEX_HOME` set the root; default is `~/.codex/sessions`.
- Conformance: the T03 journal-ingest conformance suite (stable ids across offsets) runs against the Codex fixtures.
- Live: one Codex pane in a scratch workspace; check that the thread's timeline matches the pane after a short exchange. Record as not live-tested if Codex is not installed.

## Notes for the planner

- The README says herdr reports the Codex `agent_session` kind as `id`. That was not re-checked here, since no Codex
  pane was running; `state-engine.ts` already passes both `id` and `path` kinds through.
- The adapter could not be built from real files in this draft. If the first live capture shows rollouts keyed
  differently (for example no date directories, or a name without the uuid), only `resolve` changes.

## Built

Built on feat/v2 (2026-10-17) from the Codex source, not a live capture (see "What was and was not verified").
`bridge/journal/codex.ts`, fixtures `bridge/journal/fixtures/codex-basic.jsonl` (legacy rollout) and
`codex-paginated.jsonl` (ordinals, `compacted`, `item_completed`). Deviations:

- **No merging of consecutive assistant records.** The spec says Claude's and Pi's adapters merge them; they do not
  (one entry per record), and T03 reads the log incrementally, so a merged entry would change its id when a read window
  starts inside it. One entry per response_item record keeps every id independent of the window. Runs already group a
  turn in the timeline.
- **Ids:** the item's own Responses API id (`msg_…`, `rs_…`, `fc_…`), else the line `ordinal` (`o<n>`), else
  `<type>_<call id>`, else `h_<hash of timestamp|type|first 64 chars>`; a repeat in one parse gets `~n`.
- **File names:** `rollout-YYYY-MM-DDThh-mm-ss-<thread id>.jsonl` (local time) and, for a reverted thread,
  `…-<thread id>_<rollout id>.jsonl`; both match, and the newest name in the newest day wins (as Codex's own fallback
  does). `.jsonl.zst` (Codex compresses rollouts idle for a week, and decompresses on resume) is not read. The match is a
  regex built from the validated uuid, applied to listed names only. Resolved paths are cached per id, so a later revert
  file for the same thread is not picked up until the cached file disappears.
- **Exit status:** Codex's `success` flag is not serialized, so `isError` comes from the output text: `Exit code: N` or
  `Process exited with code N` (N ≠ 0) in the header above `Output:`; the header is dropped from the shown result.
  Older `{"output":…,"metadata":{"exit_code":N}}` outputs are read too.
- **Tool names** stay Codex's own (`shell`, `shell_command`, `exec_command`, `write_stdin`, `apply_patch`,
  `update_plan`, MCP names). `local_shell_call` becomes `shell`. T03's `TOOL_ITEM_TYPES` gained `shell_command`,
  `exec_command` and `write_stdin` → `command_execution`, matching T3's Codex adapter (commandExecution); `apply_patch`
  → `file_change` and `web_search` were already there. A shell argv (`["bash","-lc","ls"]`) reads as `ls`; an
  apply_patch reads as the files it touches.
- **Also mapped:** `web_search_call` (complete with no body, `unrecorded`), `image_generation_call`,
  `tool_search_call`/`_output`, `custom_tool_call_output`, content-item outputs, raw `reasoning.content` when the summary
  is empty, and a `compacted` record as a "Context compacted" note.
- **Injected context** list (`CODEX_CONTEXT_PREFIXES`) is Codex's own matcher list: `<environment_context>`,
  `# AGENTS.md instructions`, `<skill>`, `<hook_prompt`, `<user_shell_command>`, `<turn_aborted>`,
  `<subagent_notification>`, `<agent_message_board_notification>`, `<codex_internal_context`, `<goal_context>`,
  `<recommended_plugins>`, three legacy warnings, plus the older `<user_instructions>`. `developer`/`system` messages
  are skipped too.
- **Summary length** uses the shared `oneLine` cap (200 chars), as every other adapter does, not 160.
- **No `event_msg` fallback:** Codex persists every response_item in both history modes (rollout/src/policy.rs), so
  `event_msg` rows are always duplicates.
- **Symlink test** uses a directory junction, which Windows allows without privilege, so it runs everywhere instead of
  being skipped where `CAN_SYMLINK` is false.
- **Not live-tested.** Codex is not installed here. Check the first real Codex pane's timeline against the pane.
