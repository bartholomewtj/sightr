/**
 * The command palette (`mod+k`, T13). Same job and name as T3 Code's
 * apps/web/src/components/CommandPalette.tsx @ e3b35d1b (pattern; MIT, see THIRD_PARTY.md), built on
 * T3's `ui/command` primitives and `CommandPaletteContent` (verbatim) with the matching in
 * `CommandPalette.logic.ts`. Groups: Needs you and recent threads with no query, then Threads,
 * Projects and Actions as you type. Actions are the same functions the buttons call (shelf commands
 * and their undo toasts are T10's), and only those that apply to the open thread are offered.
 * "Open file…" switches the list to the Files search for the open thread; a pick opens in the Files tab
 * (`rightPanelStore.openFile`). "Find in thread" opens the thread's find bar; "Copy thread id" and "Copy
 * folder path" use the clipboard (with the execCommand fallback) and say so in a toast.
 * A centred dialog on desktop; full height on a phone, below the status bar, with a Close button (the
 * sidebar's and a thread header's palette button open it there).
 */
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BellDotIcon,
  CircleStopIcon,
  ClockIcon,
  CopyIcon,
  FileIcon,
  FilesIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  KeyboardIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquareCheckIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { Project, Thread } from "@shared/v2/contracts";
import { timeAgoShort } from "@v1/lib/format";
import { cn } from "~/lib/utils";
import { closeCommandPalette, useCommandPaletteStore } from "@/commandPaletteBus";
import { openThreadFind } from "@/components/chat/useThreadFind";
import { CustomSnoozeDialog } from "@/components/CustomSnoozeDialog";
import { openShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { ThreadStatusDot } from "@/components/ThreadStatusIndicators";
import { useLayout } from "@/hooks/useLayout";
import { KEYBINDINGS } from "@/keybindings";
import { openRightPanelSurface, useRightPanelStore } from "@/rightPanelStore";
import { openThreadTerminal, useThreadView } from "@/threadViewStore";
import { interruptRun } from "@/state/composer";
import { performThreadCommand, useSidebarPrefs, useSidebarThreads } from "@/state/sidebar";
import { useBridgeInfo, useShell } from "@/stream/stores";
import { useUiState } from "@/uiStateStore";

import {
  applies,
  buildActionItems,
  buildFileItems,
  buildNeedsYouItems,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  filterCommandPaletteGroups,
  findHighlightedCommandPaletteItem,
  getCommandPaletteInputPlaceholder,
  getFilePickerPlaceholder,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  type CommandPaletteActionItem,
  type CommandPaletteActionSpec,
} from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { useFilePickerSearch } from "./CommandPaletteFiles";
import { copyThreadFolderPath, copyThreadId } from "./sidebar/threadCopy";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { Button } from "./ui/button";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";

const icon = (Icon: typeof PlusIcon) => <Icon className={ITEM_ICON_CLASS} aria-hidden="true" />;

export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open);
  const desktop = useLayout() === "desktop";
  const [renaming, setRenaming] = useState<Thread | null>(null);
  const [snoozing, setSnoozing] = useState<string | null>(null);

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) closeCommandPalette();
          else useCommandPaletteStore.setState({ open: true });
        }}
      >
        <CommandDialogPopup
          aria-label="Command palette"
          data-command-palette="true"
          data-testid="command-palette"
          className={cn(
            "overflow-hidden",
            !desktop &&
              "mt-[env(safe-area-inset-top)] mb-[env(safe-area-inset-bottom)] h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] max-h-none",
          )}
          onBackdropPointerDown={() => closeCommandPalette()}
        >
          {open ? <OpenCommandPaletteDialog desktop={desktop} onRename={setRenaming} onSnooze={setSnoozing} /> : null}
        </CommandDialogPopup>
      </CommandDialog>
      <RenameThreadDialog thread={renaming} onClose={() => setRenaming(null)} />
      <CustomSnoozeDialog
        open={snoozing !== null}
        onOpenChange={(next) => {
          if (!next) setSnoozing(null);
        }}
        onSnooze={(until) => {
          if (snoozing) void performThreadCommand({ type: "thread.snooze", threadId: snoozing, until });
        }}
      />
    </>
  );
}

function OpenCommandPaletteDialog(props: { desktop: boolean; onRename: (thread: Thread) => void; onSnooze: (threadId: string) => void }) {
  const navigate = useNavigate();
  const { threadId } = useParams({ strict: false }) as { threadId?: string };
  const initialQuery = useCommandPaletteStore((s) => s.initialQuery);
  const initialMode = useCommandPaletteStore((s) => s.initialMode);
  const [query, setQuery] = useState(initialQuery);
  // "files": the Open file… list. Backspace on an empty box, or the Back row, returns to the commands.
  const [mode, setMode] = useState<"commands" | "files">(initialMode ?? "commands");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const executed = useRef(false);
  const threads = useSidebarThreads();
  const projects = useShell((s) => s.projects);
  const readOnly = useBridgeInfo((s) => s.readOnly);
  const thread = threadId ? (threads[threadId] ?? null) : null;
  const { view } = useThreadView(threadId ?? "");
  const timeline = view !== "cli";
  const filesMode = mode === "files";
  const fileSearch = useFilePickerSearch(query, filesMode && threadId !== undefined);

  const fileGroups = useMemo(() => {
    if (!filesMode || !threadId) return [];
    const items = buildFileItems({
      results: fileSearch.results,
      query,
      icon: (r) => (r.kind === "dir" ? icon(FolderIcon) : icon(FileIcon)),
      openFile: (r) => useRightPanelStore.getState().openFile(threadId, r.path, r.kind),
    });
    return items.length === 0 ? [] : [{ value: "files", label: "Files", items }];
  }, [filesMode, threadId, fileSearch.results, query]);

  const commandGroups = useMemo(() => {
    const openThread = (t: Thread) => void navigate({ to: "/thread/$threadId", params: { threadId: t.id } });
    const threadList = Object.values(threads);
    const threadInput = {
      threads: threadList,
      projects,
      ...(threadId ? { activeThreadId: threadId } : {}),
      icon: icon(MessageSquareIcon),
      renderLeadingContent: (t: Thread) => <ThreadStatusDot status={t.status} showElapsed={false} />,
      formatTimestamp: (ms: number) => timeAgoShort(ms),
      runThread: openThread,
    };
    const focusProject = (p: Project) => {
      const prefs = useSidebarPrefs.getState();
      if (prefs.collapsedProjects.includes(p.id)) prefs.toggleProject(p.id);
      if (props.desktop) useUiState.getState().setSidebarOpen(true);
      void navigate({ to: "/", hash: `project-${p.id}` });
      requestAnimationFrame(() => document.querySelector(`[data-project-id="${CSS.escape(p.id)}"]`)?.scrollIntoView({ block: "center" }));
    };
    const projectList = Object.values(projects);
    const projectItems = [
      ...buildProjectActionItems({ projects: projectList, valuePrefix: "project", icon: () => icon(FolderIcon), runProject: focusProject }),
      ...buildProjectActionItems({
        projects: projectList,
        valuePrefix: "new-thread-in",
        titleFor: (p) => `New thread in ${p.label}`,
        icon: () => icon(PlusIcon),
        runProject: (p) => void navigate({ to: "/new", search: { project: p.id } }),
      }),
    ];

    const ctx = { thread, desktop: props.desktop, readOnly, timeline };
    const t = thread;
    const actionSpecs: CommandPaletteActionSpec[] = [
      { value: "new-thread", title: "New thread", icon: icon(PlusIcon), shortcutCommand: "chat.new", run: () => void navigate({ to: "/new" }) },
      {
        value: "toggle-sidebar",
        title: "Toggle sidebar",
        icon: icon(PanelLeftIcon),
        shortcutCommand: "sidebar.toggle",
        applies: applies.desktop,
        run: () => useUiState.getState().setSidebarOpen(!useUiState.getState().sidebarOpen),
      },
      {
        value: "toggle-right-panel",
        title: "Toggle right panel",
        icon: icon(PanelRightIcon),
        shortcutCommand: "rightPanel.toggle",
        applies: applies.desktop,
        run: () => useRightPanelStore.getState().toggleVisibility(),
      },
      { value: "open-terminal", title: "Open Terminal", icon: icon(TerminalSquareIcon), shortcutCommand: "terminal.toggle", applies: applies.thread, run: () => openThreadTerminal(threadId) },
      { value: "open-files", title: "Open Files", icon: icon(FilesIcon), applies: applies.thread, run: () => openRightPanelSurface("files") },
      { value: "open-git", title: "Open Git", icon: icon(GitBranchIcon), applies: applies.thread, run: () => openRightPanelSurface("git") },
      {
        value: "open-file",
        title: "Open file…",
        searchTerms: ["file", "find file", "go to file"],
        icon: icon(FolderOpenIcon),
        applies: applies.thread,
        keepOpen: true,
        run: () => {
          setMode("files");
          setQuery("");
        },
      },
      {
        value: "find-in-thread",
        title: "Find in thread",
        searchTerms: ["search", "find", "timeline"],
        icon: icon(SearchIcon),
        shortcutCommand: "chat.find",
        applies: applies.findable,
        run: () => (t ? openThreadFind(t.id) : undefined),
      },
      {
        value: "copy-thread-id",
        title: "Copy thread id",
        searchTerms: ["copy", "id", "clipboard"],
        icon: icon(CopyIcon),
        applies: applies.thread,
        run: () => (t ? void copyThreadId(t.id) : undefined),
      },
      {
        value: "copy-folder-path",
        title: "Copy folder path",
        searchTerms: ["copy", "cwd", "directory", "clipboard"],
        icon: icon(CopyIcon),
        applies: applies.hasPane,
        run: () => (t ? void copyThreadFolderPath(t.paneId) : undefined),
      },
      { value: "stop-run", title: "Stop run", icon: icon(CircleStopIcon), applies: applies.running, run: () => (t ? interruptRun(t.id) : undefined) },
      {
        value: "mark-unread",
        title: "Mark thread unread",
        icon: icon(BellDotIcon),
        applies: applies.canMarkUnread,
        run: () => (t ? void performThreadCommand({ type: "thread.markUnread", threadId: t.id }) : undefined),
      },
      {
        value: "pin",
        title: "Pin thread",
        icon: icon(PinIcon),
        shortcutCommand: "thread.pin",
        applies: applies.shelf("active", "snoozed", "settled"),
        run: () => (t ? void performThreadCommand({ type: "thread.pin", threadId: t.id }) : undefined),
      },
      {
        value: "unpin",
        title: "Unpin thread",
        icon: icon(PinOffIcon),
        applies: applies.shelf("pinned"),
        run: () => (t ? void performThreadCommand({ type: "thread.unpin", threadId: t.id }) : undefined),
      },
      { value: "snooze", title: "Snooze thread…", icon: icon(ClockIcon), applies: applies.shelf("active", "pinned"), run: () => (t ? props.onSnooze(t.id) : undefined) },
      {
        value: "settle",
        title: "Settle thread",
        icon: icon(SquareCheckIcon),
        shortcutCommand: "thread.settle",
        applies: applies.shelf("active", "pinned", "snoozed"),
        run: () => (t ? void performThreadCommand({ type: "thread.settle", threadId: t.id }) : undefined),
      },
      {
        value: "archive",
        title: "Archive thread",
        icon: icon(ArchiveIcon),
        applies: applies.shelf("active", "pinned", "snoozed", "settled"),
        run: () => (t ? void performThreadCommand({ type: "thread.archive", threadId: t.id }) : undefined),
      },
      { value: "rename", title: "Rename thread", icon: icon(PencilIcon), applies: applies.writableThread, run: () => (t ? props.onRename(t) : undefined) },
      { value: "archived", title: "Open Archived", icon: icon(ArchiveIcon), run: () => void navigate({ to: "/archived" }) },
      { value: "settings", title: "Open Settings", icon: icon(SettingsIcon), run: () => void navigate({ to: "/settings" }) },
      { value: "shortcuts", title: "Show keyboard shortcuts", icon: icon(KeyboardIcon), shortcutCommand: "shortcuts.open", applies: applies.desktop, run: () => openShortcutsDialog() },
    ];
    const actionItems = buildActionItems(actionSpecs, ctx);
    const root = buildRootGroups({
      needsYouItems: buildNeedsYouItems(threadInput),
      recentThreadItems: buildThreadActionItems({ ...threadInput, limit: RECENT_THREAD_LIMIT }),
      actionItems,
    });
    return filterCommandPaletteGroups({
      activeGroups: root,
      query,
      projectSearchItems: projectItems,
      threadSearchItems: buildThreadActionItems(threadInput),
    });
  }, [threads, projects, threadId, thread, timeline, query, readOnly, props, navigate]);
  const groups = filesMode ? fileGroups : commandGroups;

  const executeItem = (item: CommandPaletteActionItem) => {
    if (executed.current) return;
    if (item.keepOpen) {
      void Promise.resolve(item.run());
      return;
    }
    executed.current = true;
    closeCommandPalette();
    void Promise.resolve(item.run());
  };

  const backToCommands = () => {
    setMode("commands");
    setQuery("");
  };
  const filesEmptyMessage = !threadId
    ? "Open a thread to search its files."
    : (fileSearch.error ?? (fileSearch.tooShort ? "Type at least 2 characters of a file name." : fileSearch.pending ? "Searching…" : "No files match."));

  const firstItemValue = groups[0]?.items[0]?.value ?? null;
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement> & { preventBaseUIHandler?: () => void }) => {
    if (filesMode && event.key === "Backspace" && query === "" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      backToCommands();
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const item = findHighlightedCommandPaletteItem(groups, highlightedItemValue ?? firstItemValue);
    if (!item) return;
    event.preventDefault();
    event.preventBaseUIHandler?.();
    executeItem(item);
  };

  return (
    <CommandPaletteContent
      aria-label="Command palette"
      autoHighlight="always"
      footerActionLabel="Open"
      {...(filesMode ? { showBackHint: true } : {})}
      panelSize={props.desktop ? "list" : "fill"}
      inputProps={{ placeholder: filesMode ? getFilePickerPlaceholder() : getCommandPaletteInputPlaceholder(), onKeyDown: handleKeyDown }}
      {...(props.desktop ? {} : { inputAccessory: <PaletteCloseButton /> })}
      mode="none"
      items={groups}
      itemToStringValue={(item: unknown) => (item as CommandPaletteActionItem).value}
      onItemHighlighted={(value: unknown) => setHighlightedItemValue((value as CommandPaletteActionItem | undefined)?.value ?? null)}
      onValueChange={(value: string) => setQuery(value)}
      value={query}
    >
      {filesMode ? <FilesModeBar onBack={backToCommands} truncated={fileSearch.truncated} /> : null}
      <CommandPaletteResults
        {...(filesMode ? { emptyStateMessage: filesEmptyMessage } : {})}
        groups={groups}
        highlightedItemValue={highlightedItemValue}
        keybindings={KEYBINDINGS}
        onExecuteItem={executeItem}
      />
    </CommandPaletteContent>
  );
}

/** The files list's header: a Back button (a phone has no Backspace-on-empty habit) and a note when the search was cut short. */
function FilesModeBar({ onBack, truncated }: { onBack: () => void; truncated: boolean }) {
  return (
    <div className="flex items-center gap-2 border-b px-2 py-1 text-xs text-muted-foreground">
      <Button size="xs" variant="ghost-muted" aria-label="Back to commands" className="pointer-coarse:min-h-11" onClick={onBack}>
        <ArrowLeftIcon aria-hidden /> Commands
      </Button>
      <span className="min-w-0 flex-1 truncate">Open file</span>
      {truncated ? <span>Search stopped early. Try a longer name.</span> : null}
    </div>
  );
}

/** Phone: Esc is not on the keyboard, so the palette carries its own Close. */
function PaletteCloseButton() {
  return (
    <Button
      size="icon-sm"
      variant="ghost-muted"
      aria-label="Close command palette"
      className="absolute end-[var(--command-shell-inset)] top-1/2 -translate-y-1/2"
      onClick={() => closeCommandPalette()}
    >
      <XIcon />
    </Button>
  );
}

/** "Rename thread" from the palette: the same `thread.rename` command the sidebar's inline rename sends. */
function RenameThreadDialog({ thread, onClose }: { thread: Thread | null; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [forId, setForId] = useState<string | null>(null);
  if (thread && forId !== thread.id) {
    setForId(thread.id);
    setTitle(thread.title);
  }
  const submit = () => {
    const next = title.trim();
    if (!thread || !next || next === thread.title) return onClose();
    void performThreadCommand({ type: "thread.rename", threadId: thread.id, title: next });
    onClose();
  };
  return (
    <Dialog
      open={thread !== null}
      onOpenChange={(next) => {
        if (!next) {
          setForId(null);
          onClose();
        }
      }}
    >
      <DialogPopup className="max-w-sm max-sm:pb-[env(safe-area-inset-bottom)]">
        <DialogHeader>
          <DialogTitle>Rename thread</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3 px-6 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            aria-label="Thread title"
            className="h-9 rounded-lg border border-input bg-background px-3 text-base text-foreground sm:text-sm pointer-coarse:h-11"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={title.trim() === ""}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
