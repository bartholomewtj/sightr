# T14 — New thread: draft screen and spawn progress

Status: draft (T3-shape series). Depends on: T09, T10 (sidebar entry points), T12 (composer parts), T06 (`message.dispatch` queue mode for the first message), T07 (`thread.create`, `project.create`, launch table), T08 (capability flags). Read `README.md` in this folder first.

## Problem

v1 creates a pane from a sheet: name a space, or add a tab (`web/src/components/new-space-sheet.tsx`, `hooks/use-spaces.ts`, `api.createWorkspace` / `createTab`). It starts a shell; the operator then types the harness command.
In v2 a thread can be started as an agent: pick where, pick which harness, pick model and permission mode, optionally give the first message, and watch it start.

T3 reference (patterns only; MIT, comment the source if logic is adapted): T3: `docs/user/thread-sidebar.md` ("Start a thread"), `docs/user/permission-modes.md`, `apps/web/src/components/chat/ChatComposer.tsx` (the pickers row).

## Change

Route `/new` and the sheet/dialog around it, in `web2/src/components/new-thread/` and `web2/src/state/draft-thread.ts`.

### Entry points

- Sidebar header "New thread" button, a "+" on each project row (preselects that project), `mod+n` and the palette action (T13). On desktop the draft opens in the Chat region; on phone it is a full screen with a back button.
- A draft is local until sent. It is kept in `localStorage` (try/catch) so a reload keeps it, and cleared on a successful start or Discard. One draft at a time.
- A new thread opened from a project row keeps the last harness and mode used in that project (per-device preference).

### Project picker

- A list of projects from the shell store (label, number, thread count) with search. Selecting one sets `projectId` and shows its `cwd` (read-only, Consolas).
- **New project.** The last row, "New project…", opens a small form: a name and a folder path (text; the bridge validates it on the host and refuses a missing folder with the reason). It posts `project.create {cwd, label}`, which creates a herdr workspace with that cwd (T07 owns the bridge half). While it runs the row shows "Creating…"; on the `project.upserted` event whose `commandId` matches, the new project is selected. A failure keeps the form open with the bridge's reason.
- Worktree workspaces show under their primary, as in the sidebar. Picking a worktree workspace starts the thread in it. Creating worktrees is out of scope (README).
- If the shell has no projects yet, the screen opens on the New project form.

### Harness picker

- A row of tiles, one per descriptor in `AGENTS` (`shared/agents.ts`) that has a `launch` spec (T07). The table does not know what is installed on the host; a missing binary comes back as `thread.create.failed` with `stage: "agent"`. Each tile: the brand icon from `shared/agents.ts` through a copy of `web/src/components/agent-icon.tsx`, the label ("Claude Code", "Pi", "Grok Build", "Cursor CLI", "Antigravity CLI", "Codex"), and a one-line note when `capabilitiesFor(harness).hasJournal` is false ("Timeline is limited; use the Terminal tab", README "Ingest").
- Choice is a radio group (arrow keys, Space). No default except the last used in this project; with none, none is selected and Start is disabled.
- **Plain shell** is the last tile ("Terminal only"): a shell pane with no agent, for parity with v1 shells. It skips model and mode.

### Model, effort and permission pickers

- Driven by data, never by `if (harness === …)`. The T07 `launch` spec gives, per harness: `models` (suggestions `{id, label}`; free text is allowed when it matches T07's model pattern), `efforts`, and `modes` (`{id, label, value, destructive?}`). It has no defaults: nothing selected means no argument, so the harness uses its own. T08's flags (`canSwitchModel`, `canSwitchPermissionMode`, `canSetEffortLive`) say which of these can also change later, so the pickers can show "Can change after start" or "Fixed at start" under each label.
- A picker with no options for the chosen harness is not rendered. Selecting a harness clears the pickers. A permission mode marked `destructive` (for example a mode that skips approvals) shows a warn-tone line and needs a second tap to select; the command then carries `confirmBypass: true` (T07 refuses it otherwise).
- The args preview: a collapsed "Command" line shows the final command the bridge will run (`claude --model … --permission-mode …`), built by the same table through T07's pure `buildLaunchArgs` in `shared/agents.ts`. The client does not assemble arguments itself; it sends the choice ids and the bridge builds the command. The preview is display only and comes from the same function.

### Placement

- A two-way choice: **New tab** (default) or **Split current pane**. Split is enabled only when a thread is open and its pane is in the chosen project's workspace; it then offers Right or Down. Posted as T07's fields: `placement: "tab"`, or `placement: "split"` with `splitFrom: threadId` and `direction: "right" | "down"`.
- Tab name (`name` in `thread.create`): a text field prefilled from the first words of the first message once typed; empty means T07's default name. It becomes the thread title until the agent names itself.

### First message

- Optional. The same composer pieces as T12 (text box, attachments, slash menu is off here). With a message, the button reads "Start and send"; without, "Start". Enter-setting rules from T12 apply.
- The message is not typed by the browser, and `thread.create` has no message field (T07). When the `thread.created` event for this command arrives (matched by `commandId`, status `starting`), the client uploads any attachments to that thread's `paneId` and sends `message.dispatch {threadId, text, attachments, mode: "queue"}`. T06 holds it and sends it once the thread settles, so a slow start cannot lose it.
- Plain shell has no `canQueueDrain`, so it hides the first message.

### Spawn progress

After Start, the draft screen becomes a progress view bound to the `commandId` of `thread.create` and the resulting `threadId`:

1. **Creating pane** (command accepted; reply `{ sequence }`).
2. **Starting {harness}** (thread exists with status `starting`).
3. **Ready** (thread status leaves `starting`): the app navigates to `/thread/:id` after 400 ms, with the first message shown as the user item. If a first message was sent the timeline shows it queued then running.
4. **Failed** (`thread.create.failed {stage, message}` or a command error): shows the bridge's reason (herdr refused, binary not found, folder missing, herdr older than 0.9.0), the command that was tried, and two buttons, "Edit and try again" (back to the draft with everything kept) and "Open as terminal" when a pane exists and the harness exited.
- A start that has not reached Ready after 45 s shows "Still starting…" with an "Open terminal" button (T13). It does not time out by itself; the thread's own events decide.
- The progress view survives a reload: it is rebuilt from the thread's status in the shell snapshot.
- Closing the screen during progress does not cancel the start; the new thread simply appears in the sidebar with its status.

## Invariants

- The browser never builds CLI args; the bridge does, from ids.
- No harness name is tested in the UI code; options and notes come from the launch table and capabilities.
- Nothing is sent to the bridge until Start is tapped, and one tap makes one `thread.create` (same `commandId` on retry).
- A failed start never loses the draft or the first message.
- herdr older than 0.9.0: the shell shows the T09 full-screen state, so this screen is unreachable there.

## Tests

- **Draft state:** persists across reload; one draft; Discard clears; per-project last harness and mode.
- **Project picker:** list and search; preselect from a project row; New project posts `project.create` and selects the project from the `project.upserted` event with the same `commandId`; failure keeps the form open with the reason; empty shell opens on the form.
- **Harness picker:** tiles from fake descriptors with `launch`; no-journal note from `hasJournal`; radio keyboard behaviour; plain shell hides the pickers and the first message.
- **Pickers:** change with the harness; cleared on switch; hidden when empty; destructive mode needs two taps; "Can change after start" label follows capabilities; command preview equals `buildLaunchArgs` output for the same ids; a destructive mode sends `confirmBypass: true`.
- **Placement:** split disabled with no open thread or another workspace; payload shapes for tab and split.
- **First message:** button label; not in the `thread.create` body; after `thread.created`, attachments upload to its pane and one `message.dispatch` with `mode: "queue"` is posted.
- **Progress** (msw + fake shell events): creating → starting → ready navigates; failed shows reason and keeps the draft; 45 s hint; reload rebuilds state; closing the screen leaves the thread in the sidebar.
- **Idempotency:** a double tap posts one command; a network retry reuses the `commandId`.
- **a11y:** radio groups labelled; progress is an `aria-live` region.

## Notes for the planner

- Names here follow T07 (`launch.models`, `efforts`, `modes`, `buildLaunchArgs`, `thread.create.failed`) and T08 (`ThreadCapabilities`). An installed-on-host check would need a bridge probe; it is not in this series.
