# Implementation Plan: Sightr web2 Header Icon Row Follow-Up

## Overview

This follow-up refines the header icon row and right panel layout in Sightr `web2`, addressing three specific requirements:
1. **One switcher on desktop**: Remove the duplicate tab strip buttons from `RightPanelTabs.tsx`. The header `PanelToolbar` becomes the sole Terminal/Files/Git/Diff switcher on desktop. Retain the panel's close button (with shortcut title) and the resize handle. Maintain coherent accessibility semantics (`aria-controls` / `role="tabpanel"` labelled by the header button; drop `role="tablist"` from the panel cleanly; no dangling `aria-labelledby` ids). Active tab icon closes the panel; clicking another opens it through `guardPanelLeave`.
2. **No row without a thread**: On screens with no thread (new-thread screen, home/`_chat.index`), do not render `PanelToolbar` at all (not dimmed). Discard on the new-thread screen stands alone in flex flow. Sidebar toggle behavior on those screens is unchanged. Dead "disabled/no thread" code and associated tests in `PanelToolbar` are removed.
3. **Missing thread: leave as is**: The toolbar stays hidden when the open thread is missing (`missing === true`).
4. **Acceptance & Verification**: Existing tests in `PanelToolbar.test.tsx`, `ChatShell.test.tsx`, `RightPanelTabs.test.tsx`, and `RightPanelTabs.diff.test.tsx` are updated. New tests verify that an open panel shows exactly one set of four panel-kind buttons on the page (in the header), the close button remains in the panel, and screens without a thread contain no toolbar while the thread header does. Full test suite passes via `bun run --cwd web2 test`.

---

## Branch Base Note for Builder

This worktree (`draftr/sightr-header-followup-79017e70`) was created from `origin/main` (`434f740`). The initial icon row changes referenced in the contract live on git branch `header-icons-base` (commits `c998b10` and `e2b9aa9`).

Before applying the 3 follow-up changes, the builder can bring in the initial base files cleanly using:
```bash
git checkout header-icons-base -- web2/src/
```
(All files touched in `header-icons-base` are strictly within `web2/src/`, are completely disjoint from changes on `main`, and merge with zero conflicts.)

Then apply the three follow-up changes described below.

---

## Files to Touch and Detailed Changes

### 1. `web2/src/components/RightPanelTabs.tsx`
- **Remove duplicate desktop tab buttons**:
  - Remove the `RIGHT_PANEL_KINDS.map(...)` tab button loop.
  - Drop `role="tablist"` and `aria-label="Right panel tabs"` from the top strip div.
  - Replace the top strip with a simple header container for the close button:
    ```tsx
    <div className="flex h-10 items-center justify-end border-b px-2">
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Close the right panel"
        title={toggleLabel ? `Close (${toggleLabel})` : "Close"}
        onClick={() => guardPanelLeave(close)}
      >
        <XIcon />
      </Button>
    </div>
    ```
- **Retain resize handle**: Keep `<RightPanelResizeHandle />`.
- **Coherent panel semantics**:
  - Surface container uses `id="right-panel-surface"` and `role="tabpanel"`.
  - For `aria-labelledby`, point to the corresponding header button ID:
    ```tsx
    <div
      id="right-panel-surface"
      role="tabpanel"
      aria-labelledby={`panel-toolbar-tab-${active}`}
      className="flex min-h-0 flex-1 flex-col"
    >
    ```
  - When `threadId` is null (fallback state), render `<p className="p-4 text-sm text-muted-foreground">Open a thread</p>` without dangling `aria-labelledby`.

### 2. `web2/src/components/shell/PanelToolbar.tsx`
- **Desktop IDs and ARIA controls**:
  - Add `id={`panel-toolbar-tab-${kind}`}` to each button.
  - Add `aria-controls="right-panel-surface"` to each button on desktop.
- **Remove dead disabled / no-thread code**:
  - Remove `const disabled = !threadId;`.
  - Remove `aria-disabled` and `disabled={disabled}` attributes.
  - Remove the `(open a thread)` tooltip text; tooltips strictly show `${label} (${shortcut})` or `${label}`.
  - Remove `if (disabled) return;` guard.
  - Keep `threadId` prop optional for caller compatibility if needed (`threadId?: string | null`), but do not rely on it for disabling buttons.
- **Active / Inactive click handling**:
  - Desktop: if `active` (`isOpen && activeSurfaceId === kind`), click calls `close()`; otherwise calls `open(kind)` (both wrapped in `guardPanelLeave`).
  - Phone: if `active` (`sheet === kind`), click calls `closeSheet()`; otherwise calls `openSheet(kind)` (both wrapped in `guardPanelLeave`).
  - Phone CLI view: filter out `"terminal"` button when `cli === true`.

### 3. `web2/src/components/new-thread/NewThreadView.tsx`
- **Remove PanelToolbar**:
  - Remove import of `PanelToolbar`.
  - Remove `<PanelToolbar ... />` from the `<header>`.
- **Discard stands alone**:
  - The header maintains flex flow:
    ```tsx
    <header className="flex items-center gap-2 border-b px-3 py-2">
      {!desktop ? <BackToThreads /> : !sidebarOpen ? <SidebarToggle /> : null}
      <h2 className="min-w-0 flex-1 truncate font-semibold">New thread</h2>
      <DraftBranchChip />
      {!start || start.phase === "failed" ? (
        <Button size="xs" variant="outline" onClick={onDiscard}>
          Discard
        </Button>
      ) : null}
    </header>
    ```
  - `Discard` button sits at the right end of the header without any adjacent toolbar.

### 4. `web2/src/routes/_chat.index.tsx`
- **Remove PanelToolbar**:
  - Remove import of `PanelToolbar`.
  - Remove `<PanelToolbar ... />` from the desktop header.
- **Header with SidebarToggle**:
  - Keep in-flow header for desktop containing `SidebarToggle` when `!sidebarOpen`:
    ```tsx
    {desktop ? (
      <>
        {!sidebarOpen ? (
          <header className="flex h-10 items-center border-b px-3 py-2">
            <SidebarToggle />
          </header>
        ) : null}
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>Pick a thread</EmptyTitle>
            <EmptyDescription>Choose one from the list on the left.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    ) : (
      <Sidebar />
    )}
    ```

### 5. `web2/src/routes/_chat.thread.$threadId.tsx`
- **Missing thread behavior preserved**:
  - Render toolbar only when thread is loaded:
    `{!missing ? <PanelToolbar threadId={threadId} cli={cli} /> : null}`
  - When `missing === true`, toolbar remains completely hidden.
- **Timeline containment**:
  - Ensure `<div data-region="timeline" className="relative min-h-0 flex-1 overflow-hidden">` retains `overflow-hidden`.
- **In-flow header layout**:
  - Left: `{!desktop ? <BackToThreads /> : !sidebarOpen ? <SidebarToggle /> : null}`
  - Right: Find button (if desktop and not missing/cli) and `PanelToolbar`.

### 6. `web2/src/components/shell/SidebarToggle.tsx`
- In-flow button component rendering `<PanelLeftOpen className="size-4" />` with `aria-label="Show the sidebar"`.
- Clicking opens the sidebar via `setSidebarOpen(true)`.

### 7. `web2/src/components/shell/ChatShell.tsx`
- Ensure floating toggle buttons for sidebar and right panel remain removed from `<main data-region="chat">`.

### 8. `web2/src/components/chat/ThreadFindBar.tsx`
- Keep `TimelineFind` anchored with `sm:right-2` to stay strictly inside the timeline bounds.

---

## Testing and Acceptance Plan

### 1. `web2/src/components/shell/PanelToolbar.test.tsx`
- **Remove dead tests**:
  - Delete `"disables buttons and sets tooltip when threadId is absent"` test.
- **Add & update test cases**:
  - **Single switcher test on desktop**:
    - Boot desktop thread (`/v2/thread/t1`, 1280px).
    - Open right panel.
    - Query all buttons matching the panel kinds (`Terminal`, `Files`, `Git`, `Diff`).
    - Assert that exactly ONE set of 4 buttons exists in the page (within the header `PanelToolbar`).
    - Assert `within(panel).queryAllByRole("tab")` is empty (no duplicate buttons inside the panel).
    - Assert `within(panel).getByRole("button", { name: "Close the right panel" })` is present and functional.
  - **No toolbar without thread**:
    - On `/v2/new` (desktop & mobile): assert `screen.queryByRole("group", { name: "Right panel" })` is null. Verify "Discard" is visible and clickable.
    - On `/v2/` (desktop & mobile): assert `screen.queryByRole("group", { name: "Right panel" })` is null.
  - **Toolbar with thread**:
    - On `/v2/thread/t1`: assert `screen.getByRole("group", { name: "Right panel" })` is present.
    - When `missing === true`: assert toolbar is not rendered.
  - **Aria attributes**:
    - Desktop buttons have `id="panel-toolbar-tab-${kind}"` and `aria-controls="right-panel-surface"`.
    - Tabpanel surface has matching `aria-labelledby="panel-toolbar-tab-${active}"`.

### 2. `web2/src/components/shell/ChatShell.test.tsx`
- Update "collapses the right panel and remembers it" test:
  - Closes panel via `Close the right panel` button.
  - Re-opens panel via header toolbar button `screen.findByRole("button", { name: "Terminal" })`.
- Verify no absolute floating buttons exist inside `<main data-region="chat">`.

### 3. `web2/src/components/RightPanelTabs.test.tsx`
- Update tab-switching actions:
  - Replace `fireEvent.click(within(panel).getByRole("tab", { name: "Files" }))` and similar with clicking the header switcher `fireEvent.click(screen.getByRole("button", { name: "Files" }))`.
  - Verify tab switching, unmounted tabs, unsaved edits alert dialogs, and terminal deferral work correctly.

### 4. `web2/src/components/RightPanelTabs.diff.test.tsx`
- Update Diff tab tests:
  - Replace `within(panel).getAllByRole("tab")` and `within(panel).getByRole("tab", { name: "Diff" })` with querying the header toolbar buttons (`screen.getByRole("button", { name: "Diff" })`).

---

## Verification Commands

1. Run the test suite:
   ```bash
   bun run --cwd web2 test
   ```
2. Reset any modified TanStack router artifact:
   ```bash
   git checkout -- web2/src/routeTree.gen.ts
   ```
3. Check working directory status:
   ```bash
   git status
   ```
   Ensure only `web2/src/` files and the plan artifact `docs/header-icon-row-followup.md` are touched.
