# T13 — Right panel: Terminal, Files, Git; palette and keybindings

Status: done on feat/v2-web (2026-10-17). Depends on: T09 (layout slots), T10 (thread list for the palette), T12 (composer hooks into the Terminal tab). Read `README.md` in this folder first.

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

## Built

On feat/v2-web, on T3's structure (`web2/t3-upstream.json` rows added): `src/rightPanelStore.ts`,
`components/RightPanelTabs.tsx` (desktop frame) and `RightPanelSheet.tsx` (phone), the tab contents in
`components/right-panel/` (`TerminalPanel`, `TerminalMirror`, `DirectTypingStrip`, `FilesPanel`, `GitPanel`, `DiffView`),
`components/CommandPalette.tsx` + `.logic.ts` + `CommandPaletteContent.tsx` (verbatim) + `CommandPaletteResults.tsx`, T3's
`ui/command.tsx` and `ui/autocomplete.tsx` (verbatim), `commandPaletteBus.ts`, `KeyboardShortcutsDialog.tsx`,
`GlobalShortcuts.tsx` + `shortcutHandlers.ts`, and the keybinding model as T3 splits it: `src/t3/contracts/keybindings.ts`
(`@t3tools/contracts`), `src/t3/shared/keybindings.ts` (`@t3tools/shared/keybindings`: parser, matcher, `when` grammar and
`DEFAULT_KEYBINDINGS`) and `src/keybindings.ts` (`resolveShortcutCommand`, `matchBinding`, labels). Copied from v1:
`use-direct-typing.ts`, `use-ordered-key-sender.ts`, `paste-hold.ts`, `files-tree.ts`, the raw path of `AnsiMirror`,
`direct-typing-strip.tsx`, `diff-view.tsx`, and `fetchPane` (ETag cache) plus the Files/Git/local-servers helpers in
`web2/src/lib/api.ts`. Live-checked in `ca` against a scratch bridge and workspace `v2-test-T13` (shell pane + Claude
Haiku): mirror, direct typing into the shell, Files at the thread folder and the scratchpad root, Git status and diff,
mod+k jump to the Haiku thread, and the three tabs as sheets at 390 px.

Deviations:

- **Layout and names:** T3's files and names (README "same layout and names") instead of `components/palette/` and
  `keys/defaults.ts`. The default table lives where T3 keeps it (`DEFAULT_KEYBINDINGS` in the shared keybindings module).
- **Command and context names are T3's:** `thread.undo` (spec `undo.last`), `editableFocus` (spec `textFieldFocus`). Sightr
  additions: `terminal.directTyping` (ctrl+`), `rightPanel.files`, `rightPanel.git`, `shortcuts.open`. A symbol key such as `?`
  matches whatever Shift the layout needs, and Windows' AltGraph report counts as Ctrl+Alt for a Ctrl+Alt binding.
- **Who runs a command:** a registry (`shortcutHandlers.ts`); the newest mounted handler runs first and may decline. One
  capture-phase listener resolves the table, so a binding with no `when` (mod+b, mod+j, mod+alt+b) still applies while
  direct typing is armed; every `!terminalFocus` binding goes to the agent.
- **Composer keys:** Mod+Enter (`composer.sendAlternate`), Mod+Shift+Enter (`thread.steerQueuedMessage`) and Alt+Up
  (`thread.editQueuedMessage`) are table commands now. Plain Enter / Shift+Enter (they follow the Enter-mode setting, T18)
  and Escape (slash menu, queued edit) stay in the composer. The sidebar's own mod+z listener is gone (`thread.undo`).
- **Bridge addition:** threads carry no cwd, so `GET /api/files/pane-folder?pane=<id>` answers `{ path }`, the pane's folder
  as a contained rel path (null when outside the Files root). The client still never sees an absolute path.
- **Files** start at that folder, with an Up button to the root; outside the root they start at the root with a note. The
  unsaved-edits guard also covers a tab switch and closing the panel or sheet (`leaveGuard.ts`); the back gesture on a
  phone sheet closes without asking.
- **Git:** no ahead/behind (the bridge's `/api/files/git` has none). Each file's diff is folded until tapped.
- **Terminal:** "Load older" shows only when the read filled the window it asked for (600, +600 up to herdr's 1,000); the
  bridge caps a shell at 120 visible lines, so shells never offer it. web2 may not branch on harness ids. Arming is the
  explicit button or ctrl+`; clicking the mirror does not arm (v1's desktop "typing surface" pref is not ported).
- **Palette:** T3's token ranking plus a subsequence fallback ranked below it; a plain list (T3's virtualized list is not
  needed for a herd). A project row focuses it in the sidebar; "New thread in …" opens `/new?project=<id>` for T14. Rename
  uses a small dialog and Snooze the custom snooze dialog, so both work on a phone. `chat.find` is bound but declines, so the
  browser's own find keeps Ctrl+F until T19.
- **State:** the right panel's open state moved from `uiStateStore` to `rightPanelStore` (`sightr:v2:right-panel-state:v1`; the
  old `sightr:v2:right-panel` key is no longer read). `uiStateStore` gained `sidebarOpen` for mod+b.
- **Keys pad:** `nav-tray.tsx` and `key-queue-strip.tsx` moved to `components/keys/`, used by the composer and the Terminal tab.
- Two timeline tests (T11) waited a fixed 200 ms for the list to re-render and failed under the larger parallel run; they
  now `waitFor` the result.
