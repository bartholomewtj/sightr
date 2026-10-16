# T13 — Right panel: Terminal, Files, Git; palette and keybindings

Status: draft (T3-shape series). Depends on: T09 (layout slots), T10 (thread list for the palette), T12 (composer hooks into the Terminal tab). Read `README.md` in this folder first.

## Problem

In v1 the terminal mirror is the main view and is polled for every open pane. In v2 the timeline is the main view, and the mirror is a tool: needed when a harness has no journal, when a dialog is not lifted
into a request, or when the operator wants to type straight to the agent. Files and git status are separate v1 routes (`routes/files.tsx`, `components/files-git.tsx`). v2 groups them as tabs in a right panel
(desktop) or sheets (phone), and adds a `mod+k` palette and a keybinding table.

T3 reference (patterns only; MIT, comment the source if logic is adapted): T3: `apps/web/src/components/RightPanelTabs.tsx`, `CommandPalette.logic.ts`, `packages/shared/src/keybindings.ts` (default table and `when` grammar), `docs/user/keybindings.md`.

## Change

All in `web2/src/components/right-panel/`, `web2/src/components/palette/`, `web2/src/keys/`.

### Panel frame

- Desktop (≥ 1024 px): the right region from T09, tabs **Terminal**, **Files**, **Git**. Width draggable (320–720 px), collapsible with `mod+alt+b`; open state and active tab are per-device preferences (try/catch `localStorage`). It targets the open thread; with no thread, it shows "Open a thread".
- Phone (< 1024 px): three buttons in the thread header (Terminal, Files, Git) open a full-height `BottomSheet` (copy `web/src/components/ui/sheet.tsx`). One sheet at a time; the system back gesture closes it before leaving the thread (`history.pushState` entry per open sheet; `popstate` closes).
- Only the active tab's content is mounted. Closing the panel or sheet unmounts it, which stops all its network work.

### Terminal tab

- **Reads the pane only while the tab is open and the page is visible.** `useMirror(paneId)` polls `fetchPane(paneId, lines)` (copy `fetchPane` with its ETag cache from `web/src/lib/api.ts`) every 1.5 s while typing or the thread is `working`, 4 s otherwise (the `HOT_MS`/`COLD_MS` idea in `web/src/hooks/use-polling.ts`),
  aborts in-flight reads on unmount, and stops on `visibilitychange: hidden`. A 304 keeps the cached body. This is the only place v2 calls `/api/pane/:id`. Telemetry class is `pane` through the existing `fetchClassOf`.
- **Render.** Copy the ANSI row rendering of `web/src/components/ansi-output.tsx` (`AnsiMirror`) with `@v1/lib/ansi` and `@v1/lib/blocks`, in raw mode (no lifted dialog cards: requests are T12's job). Consolas, a font size control (10–16 px, per device), an inverted palette in light mode (ADR 0002).
  Follow-tail with a "Jump to latest" pill. "Load older" asks `lines` larger, as v1 does for shells.
- **Direct typing.** A toggle "Type into terminal" (and `ctrl+\`` on desktop). While armed, a strip says so (copy `direct-typing-strip.tsx`) and keystrokes go straight to the pane: copy `hooks/use-direct-typing.ts` and `lib/direct-arm.ts`; the desktop key mapper is `@v1/lib/desktop-keymap` (`handleDesktopKeyDown`); keys are sent with the existing `sendKeys` helper to `POST /api/pane/:id/keys`.
  The v1 rules stay: the reply guard is not run on these keys; the mode disarms on blur, on a failed batch, and when the page is hidden; text paste goes through the paste hold (`lib/paste-hold.ts`, copy) which asks before sending multi-line or destructive text.
- **Keys pad** (phone and touch): the same dock as T12, here docked under the mirror. One implementation (`web2/src/components/keys/`), used by both.
- **Password requests.** T12's "Open terminal" opens this tab and arms direct typing, with the strip naming the prompt.
- Read-only devices see the mirror, not the controls.

### Files tab

- Reuses the v1 endpoints: `fetchFiles`, `searchFiles`, `downloadFileUrl`, `openFileUrl`, `saveFile`, `deleteFile`, `fetchLocalServers` helpers copied from `web/src/lib/api.ts`, and the tree logic `files-tree.ts` (copy). Root is the thread's `cwd` (from the shell snapshot).
- Tree plus search on top; a file opens in a detail view inside the tab (text preview, image/video/audio embed, download, "Open in browser" through the sandboxed `files/open` URL, ADR 0027). Edit and delete follow the v1 rules in `routes/files.tsx`: dirty-state guard on leaving, delete needs a second tap, read-only devices get neither.
- The path always stays inside the bridge's containment (`bridge/containment.ts`, ADR 0026); the client does no path logic beyond joining names.
- The v1 "Local" servers list is a section at the bottom of this tab ("Servers on this PC"), same data as `routes/local.tsx`.

### Git tab (read-only)

- `fetchFolderGit(cwd, [paneId])` from the v1 API: branch, ahead/behind, changed files with status letters, and a diff per file using a copy of `diff-view.tsx` (`parseDiff`). Refresh button; auto-refresh when the thread's run ends (the run reaching a final status in the thread stream). No stage, commit, push or PR: out of scope (README).
- If the folder is not a repo: "This folder is not a git repository."

### Command palette (`mod+k`)

- Opens a centred dialog on desktop and a full-height sheet on phone (a search icon in the sidebar header opens it). Input at top, grouped results below: **Threads**, **Projects**, **Actions**. Pure logic in `palette.logic.ts` (T3: `CommandPalette.logic.ts` for the matching idea).
- **Threads:** title, project, harness, status dot; matches on title, project label and harness with a simple scored subsequence match; empty query lists "Needs you" first, then recent by `lastActivityAt`. Enter opens. **Projects:** jump to a project (focuses it in the sidebar; on phone opens the list scrolled to it) and "New thread in {project}" (T14).
- **Actions** (only those that apply now): New thread, Toggle sidebar, Toggle right panel, Open Terminal / Files / Git, Stop run, Mark thread unread, Pin / Snooze / Settle / Archive thread, Rename thread, Open Archived, Open Settings (the page is T18), Show keyboard shortcuts.
  Actions run the same functions as the buttons, so commands and undo toasts (T10) are shared.

### Keybindings

- A table `web2/src/keys/defaults.ts` of `{ key, command, when? }` and a matcher `matchBinding(event, context)`. `mod` is Ctrl on Windows/Linux and Cmd on Apple (`navigator.platform` / `userAgentData`; testable via an injected platform). Key strings are normalised the way T3's `normalizeEventKey` does (lower case, `arrowup`, `enter`).
- **Context (`when`) keys** set by the app: `terminalFocus` (direct typing armed, or focus inside the mirror), `composerFocus`, `turnRunning`, `rightPanelOpen`, `paletteOpen`, `textFieldFocus`. Grammar: `&&`, `||`, `!`, parentheses. A binding with no `when` always applies, except inside a text field for single-key bindings.
- **Defaults** (a subset of T3's table, from `keybindings.ts`, that fits Sightr):

| Key | Command | When |
|---|---|---|
| `mod+k` | commandPalette.toggle | `!terminalFocus` |
| `mod+b` | sidebar.toggle | |
| `mod+alt+b` | rightPanel.toggle | |
| `mod+j` | terminal.toggle (open Terminal tab) | |
| `mod+n` | chat.new | `!terminalFocus` |
| `mod+f` | chat.find (find in timeline; does nothing until T19 builds find) | `!terminalFocus` |
| `mod+z` | undo.last | `!textFieldFocus` |
| `mod+enter` | composer.sendAlternate | `composerFocus && turnRunning` |
| `mod+shift+enter` | thread.steerQueuedMessage | `!terminalFocus` |
| `alt+arrowup` | thread.editQueuedMessage | `composerFocus` |
| `ctrl+alt+arrowup/down` | thread.previous / thread.next | |
| `?` | shortcuts.open | `!textFieldFocus && !terminalFocus` |

  While direct typing is armed, `terminalFocus` is true and every binding that has `!terminalFocus` is off, so the agent gets the key. `ctrl+\`` toggles direct typing and is never blocked. `mod+w`, `mod+t`, `mod+d`, the preview, workspace and branch bindings from T3 are not taken.
- A shortcuts sheet (`?`) lists the table. Overrides are not in this slice: the table is code, which keeps the test surface small.
- Browser-reserved keys (`mod+t`, `mod+w`, `mod+n` in some browsers) may not reach the page; `chat.new` is also on `mod+alt+n` and in the palette.

## Invariants

- The Terminal tab makes no pane read unless it is mounted, visible and the page is visible.
- Direct typing never runs the reply guard and always disarms on blur, failure or hide (v1 rules).
- No key binding fires while a text field has focus unless it has a modifier, and none with `!terminalFocus` fires while direct typing is armed.
- Git is read-only. Files writes obey the v1 read-only-device and containment rules.
- Palette actions and buttons share one code path.

## Tests

- **Mirror hook:** polls only while mounted and visible; 1.5 s hot / 4 s cold (fake timers); hidden page stops; unmount aborts; 304 keeps the text.
- **Terminal tab:** arming shows the strip; a key press posts `/api/pane/:id/keys`; blur disarms; multi-line paste is held; read-only hides controls; password flow arms with the prompt named.
- **Panel frame:** desktop tabs switch and keep width; collapse state persists; phone buttons open one sheet; back closes the sheet and stays on the thread.
- **Files tab** (msw): tree load, search, text preview, edit with dirty guard, delete two-tap, read-only, local servers section.
- **Git tab** (msw `folder-git`): changed files, diff expand, not-a-repo message, refresh on run end.
- **Palette logic:** scoring order, "Needs you" first on empty query, project entries, actions filtered by context; Enter opens a thread.
- **Keybinding matcher:** `mod` mapping per platform; `when` grammar (and, or, not, parentheses, unknown key is false); terminalFocus suppresses `mod+k`; `mod+z` ignored in a textarea; `?` ignored in a text field.
- **Shortcuts sheet** renders every default.
