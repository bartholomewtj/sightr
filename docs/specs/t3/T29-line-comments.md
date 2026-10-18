# T29 — Line comments on a diff become quoted text in the composer

Status: draft (diffs series). Depends on: T25 (the `DiffCodeView` seam and its annotation hook), T27 (the diff panel), T12 (composer). Plan: [`docs/T3_ADAPTATION.md`](../../T3_ADAPTATION.md). Read `README.md` in this folder first. web2 only: no bridge, contract or migration change.

## Problem

Reviewing a diff on the phone ends in typing "in `foo.ts` around line 40, the second `if`..." from memory. T3 solves it with inline line comments (`AnnotatableCodeView`, `DiffCommentAnnotation`, `commentSubmitShortcut.ts`) that `reviewCommentContext.ts` (476 lines) turns into context in a Tiptap composer, and a chat card that shows the quoted lines. Sightr's composer is a plain `<textarea>` (`web2/src/components/chat/ChatComposer.tsx`) so phone dictation works, and the agent only ever receives text typed into its pane (`bridge/threads/dispatch.ts` `messageText`, bracketed paste in `bridge/pane-write-routes.ts`). So a comment must end up as plain, readable text in the draft. Nothing else about sending changes.

## Change

### Gesture (T27 panel, on T25's seam)

T29 needs three capabilities from the seam and T25 records their names: a per-row gutter action `{side, line, shiftKey}`, a controlled `selection {side, start, end}`, and an annotation row rendered under a line range. T29 is renderer-agnostic and imports no `@pierre/*`.
- **Desktop:** hover shows a "+" in the gutter; click opens the editor on that line; shift-click extends from the anchor. Escape cancels. A range lives on one side: `old` (deleted and context rows, old numbers) or `new` (added and context rows, new numbers), set by the first row clicked. Rows with no number on that side are skipped; a range never spans two hunks (a click in another hunk moves the anchor); at most 12 lines (the gesture stops and says "12 lines is the limit").
- **Phone (primary):** tap the line-number gutter. The gutter hit area is at least 44 px wide under `pointer-coarse`. The tap fires on `pointerup` only when the pointer moved under 8 px and was down under 500 ms, and `touch-action` stays `pan-y`, so a vertical scroll that starts on the gutter never selects. No shift key: with the editor open, tapping another gutter number extends the range to it (the shift-click rule), and the editor shows `12-15` with a Clear range button.
- **Phone (optional second path):** long-press on a line (450 ms, cancelled by movement over 8 px). It needs `-webkit-touch-callout: none` and a `contextmenu` preventDefault on the diff rows or iOS selection and Android's menu take the press. That also stops text selection inside the diff on touch, which Copy diff covers. Not verified on a real phone: if the live check shows the press fighting native selection, drop it; the gutter tap alone meets the phone requirement.
- **Editor:** an annotation row under the last selected line: a `<textarea>` (`autocapitalize="sentences"`, dictation works), Save and Cancel buttons at 44 px on touch. Mod+Enter saves on desktop (`commentSubmitShortcut.ts`; exact key rule verified at build). Enter adds a line everywhere else. The row scrolls into view (`block: "nearest"`) when the iOS keyboard opens; the sheet already shrinks above it (`lib/keyboard-inset.ts`). Saved comments show as a note row under the range; tap opens edit/delete.
- Disabled, with the reason shown, on a read-only device (`useBridgeInfo` `readOnly`), for a path that is absolute, has `..` or a backslash (T27 passes repo-relative forward-slash paths), and for a refused path (Secrets).

### Pending comments

`web2/src/state/lineComments.ts` (zustand, per thread): `{id, path, side, start, end, hash, quote: string[], note, createdAt, state}`. Saving puts the comment in the list; it never touches the draft by itself.
- **Persisted like drafts:** `localStorage` key `sightr:v2:line-comments:<threadId>` with try/catch and a memory fallback, 48 h prune (the `web2/src/lib/drafts.ts` rules). Max 30 per thread ("Pending list is full"). A note over 1,000 characters is refused at Save.
- **Chip with count:** "Comments 3" in the T27 panel header (opens the list inside the panel; on a phone a second sheet is not allowed) and a row above the composer box beside the attachment chips: `3 review comments · Add to message · View · Discard`. The composer row hides while a request replaces the box.
- **List rows:** `path:12-14`, side, note, and a derived state: `pending`, `in message` (`draft.includes(block)`, computed, never stored), `moved`, `outdated`. Per row: Add, Edit, Delete (5 s Undo through `showThreadUndoNotice`). Header: Add all, Discard all (second tap). Cleared on send or by an explicit discard only.

### Composer insertion format (`reviewCommentContext.ts`)

Pure `formatReviewBlock(comment)`, `parseReviewBlocks(text)`, `blockHash(lines)`. Deterministic, one block per comment, blocks separated by one blank line:

````
[review] src/lib/foo.ts:12-14 (new)
```diff
+const a = 1;
 const b = 2;
+const c = 3;
```
> Rename `a` to say what it counts.
> Second line of the note.
````

- Header `[review] <path>:<start>[-<end>] (<old|new>[, outdated])`. Quote: each line prefixed `+`, `-` or space (a diff excerpt, which agents read natively; `new` side never has `-` lines, `old` never `+`). A line over 160 characters is cut with `…` in the quote (the hash uses the full line). The fence is three backticks, or one more than the longest backtick run in the quote. Note: every line prefixed `> `, empty lines `>`.
- It starts with `[`, never `/`, `!` or `#`, so it cannot open the slash menu (`slashQuery`) or a harness mode on its first character. The same text renders as a code block in the timeline with no change (`CollapsibleUserMessageBody` uses `ChatMarkdown`).
- Parser: tolerates `\r\n`, requires the header at a line start, then the fence, then the `>` run; anything else is left as the user's own text. Round trip: `parse(format(c))` returns path, range, side, quote and note exactly. The hash is not in the text.
- **Added by an "Add to message" button, appended at the end of the draft** (a blank line before it unless the draft is empty), never inserted mid-text and never automatic. The draft is the user's words; the list is the basket. Implementation: `ThreadComposer.insertion {id, text}` in `web2/src/state/composer.ts` with `requestInsert`/`consumeInsert` (the `requestDirectTyping` pattern in `rightPanelStore.ts`); `ChatComposer.tsx` consumes it through its own `setText`, so `saveDraft`, autosize and the length check all run. Phone: Add closes the sheet (Back pops the history entry) and does not focus the box (no surprise keyboard); a toast says "Added 3 comments to your message". Desktop keeps the panel open and focuses the box.
- **Queue and steer:** nothing special. The block is ordinary text; the existing primary button decides Send, Queue or Steer from the thread state (`resolveComposerButtons`). Queue stores the text on the bridge, so comments clear when the dispatch reply returns, as the draft does. While editing a queued message, Add appends to the edit buffer. The existing destructive-text guard (`isDestructiveInput`) still scans the whole message: quoted `rm -r` or `sudo` asks one extra tap. Kept on purpose.
- **While a request replaces the box:** the textarea is unmounted but `ChatComposer` and its text state are not, so Add still works; the toast adds "The agent is asking something; your message is waiting". Commenting itself is unaffected.
- Needs `capabilities.canQueueDrain` (an agent that takes a pasted multi-line message). A plain shell thread has none, and its lines would each run: the gutter stays, Add is disabled with "This pane is a shell".
- **Clear on send:** `dispatchMessage` success (and `saveQueuedEdit` success) calls `consumeSent(threadId, text)`, which deletes the comments whose block is in the sent text. A refusal keeps everything; a guard-refused start that puts the text back keeps the blocks in the box, which is then the copy.

### Limits

Per message: 10 comments and 12,000 characters of blocks, counted by parsing the draft. Per comment: 12 quoted lines, 160 characters per quoted line, 1,000 note characters. Add all stops before a limit ("Added 4 of 6. Send, then add the rest."). The 64 KiB composer cap (`MAX_COMPOSER_CHARS`) stays. The panes take long text as 1,000-character bracketed-paste chunks and verify it through the harness paste token (`web/src/lib/harness/paste-token.ts`: newline count and tail must match), so 12,000 is about 12 pastes; tune the numbers live. `drafts.ts` keeps only 8 KiB on disk (`fitsDraftStore`), which is why the comment list holds its own persisted copy.

### Stale comments

A comment is anchored by `path + side + start + end + hash` (FNV-1a, 8 hex, over the full quoted lines). When the diff for its file loads or refreshes (`useRunEnded`, visibility): same range and hash, `anchored`; else the same run of lines found at another place on that side, update the range, `moved`; else `outdated`. Outdated comments stay in the list with the quote, show an "Outdated" badge, and are never dropped. Add on one inserts it with `, outdated` in the header, after a confirm tap ("This code changed since you commented"). A file missing from the current scope is also `outdated`. Scope is not part of the anchor: the same comment shows in any scope where it still matches.

### Timeline card (optional, build last)

Decision: yes, but minimal and last. Without it the block already renders as a code block and the slice is complete. With it: `parseReviewBlocks` splits a `user_message` into text and review segments; `UserTimelineRow` in `MessagesTimeline.tsx` renders each review segment as a collapsed `ReviewCommentCard` (header chip `path:12-14 new`, tinted quote on expand with the T27 line styles, note below) and the rest as `ChatMarkdown`. No `FileDiff` renderer, no live diff lookup. The existing 8-line/600-character collapse still applies. Cut it if `MessagesTimeline.tsx` is under change; T29 does not depend on it.

### Secrets

Comments quote file content, so the Files refusal list applies. The bridge already counts refused paths without sending them (`isHiddenPath` in `bridge/workdir-git.ts`), so T26 lists never show one, but T24/T27's journal scope shows `file_change.fileName` straight from the journal. `web2/src/lib/refusedPaths.ts` copies `isRefusedName` (`bridge/workdir.ts:96`: dot names, `node_modules`, `config`, key and certificate extensions, `id_*`) and applies it to every path segment; a refused path gets no gutter and no quote. Content of a non-refused file is not scanned; the user sees the exact text in the list before it is added.

### Ledger (`web2/t3-upstream.json`; T3 `main` 3a4d118a518a, re-pin and confirm each upstream path at build)

| local | upstream | mode |
|---|---|---|
| `src/components/diffs/commentSubmitShortcut.ts` | `apps/web/src/components/diffs/commentSubmitShortcut.ts` (15 lines) | verbatim |
| `src/components/diffs/AnnotatableCodeView.tsx` | `AnnotatableCodeView` (291, Pierre-coupled) | pattern, over T25's seam |
| `src/components/diffs/DiffCommentAnnotation.tsx` | `DiffCommentAnnotation` (136) | pattern; adapted if free of Pierre types |
| `src/lib/reviewCommentContext.ts` | `reviewCommentContext.ts` (476, Tiptap-coupled) | pattern: only the context-formatting idea; no composer-store or editor code |

New Sightr-only files: `lineComments.ts`, `refusedPaths.ts`, `lineSelection.ts` (range logic), `ReviewCommentCard.tsx` (optional). Not in this slice: checkpoints, bridge or contract changes, T3-style persisted review threads, replies, resolving, comments on the Files tab or the timeline's inline diffs.

## Invariants

- Nothing is typed into a pane by T29; the only path out is the composer's `message.dispatch`.
- Saving a comment never edits the draft; the draft changes only on an explicit Add.
- A comment is removed only by Delete, Discard, or a confirmed send of its exact block. Never by a diff change.
- A refused path never appears in a comment, a quote or a message.
- Phone: every action works with taps only, targets are 44 px, and a scroll never creates a selection.

## Tests

- `web2/src/lib/reviewCommentContext.test.ts`: format golden; round trip for one line, a range, both sides, a quote containing a backtick fence, multi-line notes with blank lines and `>` text, `\r\n`, tabs, unicode, a 200-character line, `outdated`; text around blocks survives; a non-matching header stays user text; limits and Add-all stop.
- `web2/src/state/lineComments.test.ts`: persist and reload, throwing storage, 48 h prune, cap 30, re-anchor (anchored, moved, outdated, missing file), `consumeSent` removes only blocks present in the sent text, derived `in message`.
- `web2/src/components/diffs/lineSelection.test.ts` and `commentSubmitShortcut.test.ts`: side from first row, shift extend, skipped rows, no cross-hunk, 12-line cap, anchor move; the shortcut cases from T3.
- `web2/src/components/diffs/DiffCommentEditor.test.tsx`: Mod+Enter saves, Escape cancels, gutter tap saves nothing when the pointer moved 20 px, long tap does not fire, second tap extends.
- `web2/src/lib/refusedPaths.test.ts`: the table from `bridge/workdir.test.ts`, plus journal-style absolute paths refused.
- `web2/src/components/chat/ChatComposer.reviewComments.test.tsx`: Add appends and saves the draft; working thread keeps Queue or Steer by setting; with a pending request the draft updates and the toast shows; queued edit appends to the buffer; a shell thread disables Add; send clears; a 500 and a `dispatch.failed` keep comments or blocks; the destructive tap still applies.
- Optional: `MessagesTimeline.test.tsx` card renders from a block, collapses, falls back for malformed text.
- **Live, in a scratch herdr workspace, 390 px, on a real phone:** run an agent that edits two files; open the Diff sheet; tap a gutter number with the page still scrolling (no selection), comment on a range using a second tap, dictate a note, Add, send to a Claude pane and read the pane (the block is intact, one message, no `[Pasted text` stall), then queue one while it works. Edit the file and refresh to see Outdated. Real-touch caveats not covered by jsdom: long-press vs native selection, `pointer-coarse`, iOS keyboard inset on the editor, gutter taps against momentum scroll.

## Open questions

- Is `canQueueDrain` the right gate for "takes a multi-line message", or does a shell need its own capability flag (a bridge slice)?
- Are 10 comments / 12,000 characters / 12 lines right for the live panes? They are starting values.
- Should an outdated comment be addable at all, or only viewable?
