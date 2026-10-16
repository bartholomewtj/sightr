/**
 * The command palette (`mod+k`, T13). Same job and name as T3 Code's
 * apps/web/src/components/CommandPalette.tsx @ e3b35d1b (pattern; MIT, see THIRD_PARTY.md), built on
 * T3's `ui/command` primitives and `CommandPaletteContent` (verbatim) with the matching in
 * `CommandPalette.logic.ts`. Groups: Needs you and recent threads with no query, then Threads,
 * Projects and Actions as you type. Actions are the same functions the buttons call (shelf commands
 * and their undo toasts are T10's), and only those that apply to the open thread are offered.
 * A centred dialog on desktop; full height on a phone (the sidebar's search icon opens it there).
 */
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArchiveIcon,
  BellDotIcon,
  CircleStopIcon,
  ClockIcon,
  FilesIcon,
  FolderIcon,
  GitBranchIcon,
  KeyboardIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SettingsIcon,
  SquareCheckIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { Project, Thread } from "@shared/v2/contracts";
import { timeAgoShort } from "@v1/lib/format";
import { cn } from "~/lib/utils";
import { closeCommandPalette, useCommandPaletteStore } from "@/commandPaletteBus";
import { CustomSnoozeDialog } from "@/components/CustomSnoozeDialog";
import { openShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { ThreadStatusDot } from "@/components/ThreadStatusIndicators";
import { useLayout } from "@/hooks/useLayout";
import { KEYBINDINGS } from "@/keybindings";
import { openRightPanelSurface, useRightPanelStore } from "@/rightPanelStore";
import { interruptRun } from "@/state/composer";
import { performThreadCommand, useSidebarPrefs, useSidebarThreads } from "@/state/sidebar";
import { useBridgeInfo, useShell } from "@/stream/stores";
import { useUiState } from "@/uiStateStore";

import {
  applies,
  buildActionItems,
  buildNeedsYouItems,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  filterCommandPaletteGroups,
  findHighlightedCommandPaletteItem,
  getCommandPaletteInputPlaceholder,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  type CommandPaletteActionItem,
  type CommandPaletteActionSpec,
} from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
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
          className={cn("overflow-hidden", !desktop && "h-[calc(100dvh-2rem)] max-h-none")}
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
  const [query, setQuery] = useState(initialQuery);
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const executed = useRef(false);
  const threads = useSidebarThreads();
  const projects = useShell((s) => s.projects);
  const readOnly = useBridgeInfo((s) => s.readOnly);
  const thread = threadId ? (threads[threadId] ?? null) : null;

  const groups = useMemo(() => {
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
        runProject: (p) => void navigate({ to: "/new", search: { project: p.id } as never }),
      }),
    ];

    const ctx = { thread, desktop: props.desktop, readOnly };
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
      { value: "open-terminal", title: "Open Terminal", icon: icon(TerminalSquareIcon), shortcutCommand: "terminal.toggle", applies: applies.thread, run: () => openRightPanelSurface("terminal") },
      { value: "open-files", title: "Open Files", icon: icon(FilesIcon), applies: applies.thread, run: () => openRightPanelSurface("files") },
      { value: "open-git", title: "Open Git", icon: icon(GitBranchIcon), applies: applies.thread, run: () => openRightPanelSurface("git") },
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
      { value: "shortcuts", title: "Show keyboard shortcuts", icon: icon(KeyboardIcon), shortcutCommand: "shortcuts.open", run: () => openShortcutsDialog() },
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
  }, [threads, projects, threadId, thread, query, readOnly, props, navigate]);

  const executeItem = (item: CommandPaletteActionItem) => {
    if (executed.current) return;
    executed.current = true;
    closeCommandPalette();
    void Promise.resolve(item.run());
  };

  const firstItemValue = groups[0]?.items[0]?.value ?? null;
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement> & { preventBaseUIHandler?: () => void }) => {
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
      panelSize={props.desktop ? "list" : "fill"}
      inputProps={{ placeholder: getCommandPaletteInputPlaceholder(), onKeyDown: handleKeyDown }}
      mode="none"
      items={groups}
      itemToStringValue={(item: unknown) => (item as CommandPaletteActionItem).value}
      onItemHighlighted={(value: unknown) => setHighlightedItemValue((value as CommandPaletteActionItem | undefined)?.value ?? null)}
      onValueChange={(value: string) => setQuery(value)}
      value={query}
    >
      <CommandPaletteResults
        groups={groups}
        highlightedItemValue={highlightedItemValue}
        keybindings={KEYBINDINGS}
        onExecuteItem={executeItem}
      />
    </CommandPaletteContent>
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
      <DialogPopup className="max-w-sm">
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
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
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
