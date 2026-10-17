/**
 * The thread sidebar (T10). Same job and name as T3 Code's apps/web/src/components/Sidebar.tsx; Sightr's
 * own component on the same pieces (Base UI menu, @dnd-kit drag, Sidebar.logic.ts).
 *
 * Projects (herdr workspaces, worktrees nested under their primary checkout) hold four shelves:
 * Pinned, Active, Snoozed, Settled. Archived threads live at /archived. Every shelf change is a bridge
 * command (state/sidebar.ts), applied optimistically and undoable. Above the list: All / Needs you and
 * a search box (either flattens the list). The sidebar renders only from the shell stream's store.
 */
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Command, GitBranch, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import type { Thread } from "@shared/v2/contracts";

import { Button } from "~/components/ui/button";
import { openCommandPalette } from "@/commandPaletteBus";
import { CustomSnoozeDialog } from "@/components/CustomSnoozeDialog";
import { PushOnboarding } from "@/components/settings/PushOnboarding";
import { handleSidebarDrop, sectionDropId, useSidebarDrag, zoneFor } from "@/components/Sidebar.drag";
import {
  buildProjectTree,
  documentTitle,
  needsYouThreads,
  resolveAdjacentThreadId,
  rollUpStatus,
  searchSidebarThreads,
  type ShelfCommand,
  type SidebarProjectNode,
  type SidebarSection,
} from "@/components/Sidebar.logic";
import { SidebarRowContext, SidebarThreadRow, SortableThreadRow, type SidebarRowActions } from "@/components/sidebar/SidebarThreadRow";
import { ProjectRenameField, ProjectRowMenu } from "@/components/sidebar/ProjectRowMenu";
import { useLongPress } from "@/components/sidebar/useLongPress";
import { ThreadRowMenu } from "@/components/sidebar/ThreadRowMenu";
import { ThreadStatusDot } from "@/components/ThreadStatusIndicators";
import { useLayout } from "@/hooks/useLayout";
import { KEYBINDINGS, shortcutLabelForCommand } from "@/keybindings";
import { cn } from "@/lib/utils";
import { performThreadCommand, renameProject, useSidebarPrefs, useSidebarThreads } from "@/state/sidebar";
import { useShell } from "@/stream/stores";

const SECTION_LABEL: Record<SidebarSection, string> = { pinned: "Pinned", active: "Active", snoozed: "Snoozed", settled: "Settled" };

export function Sidebar() {
  const desktop = useLayout() === "desktop";
  const paletteKey = desktop ? shortcutLabelForCommand(KEYBINDINGS, "commandPalette.toggle") : null;
  const newKey = desktop ? shortcutLabelForCommand(KEYBINDINGS, "chat.new") : null;
  const loaded = useShell((s) => s.loaded);
  const projects = useShell((s) => s.projects);
  const threads = useSidebarThreads();
  const threadList = useMemo(() => Object.values(threads), [threads]);
  const tree = useMemo(() => buildProjectTree(Object.values(projects), threadList), [projects, threadList]);
  const needsYou = useMemo(() => needsYouThreads(threadList), [threadList]);
  const archivedCount = useMemo(() => threadList.filter((t) => t.shelf === "archived").length, [threadList]);
  const filter = useSidebarPrefs((s) => s.filter);
  const setFilter = useSidebarPrefs((s) => s.setFilter);
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchSidebarThreads(threadList, projects, query), [threadList, projects, query]);
  const { threadId: activeThreadId } = useParams({ strict: false }) as { threadId?: string };

  const [menu, setMenu] = useState<{ threadId: string; anchor: HTMLElement } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [snoozePick, setSnoozePick] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; anchor: HTMLElement } | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const projectActions = useMemo<ProjectActions>(
    () => ({
      renamingId: renamingProjectId,
      openMenu: (projectId, anchor) => setProjectMenu({ projectId, anchor }),
      endRename: () => setRenamingProjectId(null),
    }),
    [renamingProjectId],
  );

  useEffect(() => {
    if (!desktop) return;
    document.title = documentTitle(needsYou.length);
    return () => {
      document.title = "Sightr";
    };
  }, [desktop, needsYou.length]);

  const run = useCallback((command: ShelfCommand) => void performThreadCommand(command), []);
  const actions = useMemo<SidebarRowActions>(
    () => ({
      activeThreadId,
      touch: !desktop,
      renamingId,
      openMenu: (threadId, anchor) => setMenu({ threadId, anchor }),
      startRename: setRenamingId,
      endRename: () => setRenamingId(null),
      run,
    }),
    [activeThreadId, desktop, renamingId, run],
  );

  // Up/Down move focus between rows (screen order), as T3's thread traversal.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const target = e.target as HTMLElement;
    if (!target.matches("[data-sidebar-row], [data-project-row]")) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-sidebar-row], [data-project-row]")];
    const next = resolveAdjacentThreadId({ threadIds: rows, currentThreadId: target, direction: e.key === "ArrowDown" ? "next" : "previous" });
    if (next && next !== target) {
      e.preventDefault();
      next.focus();
    }
  };

  const flat: Thread[] | null = query.trim() ? results : filter === "needs-you" ? needsYou : null;
  const menuThread = menu ? (threads[menu.threadId] ?? null) : null;

  return (
    <SidebarRowContext.Provider value={actions}>
      <nav
        aria-label="Threads"
        className="flex min-h-0 flex-1 flex-col bg-sidebar text-sidebar-foreground"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center justify-between gap-1 px-4 pt-3 pb-2">
          <span className="flex-1 font-semibold">Sightr</span>
          {/* T14: start a thread (mod+n, the palette and each project row's "+" too). */}
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label="New thread"
            title={newKey ? `New thread (${newKey})` : "New thread"}
            render={<Link to="/new" />}
          >
            <Plus aria-hidden />
          </Button>
          {/* T13: the command palette (mod+k on desktop; the only way in on a phone). */}
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label="Command palette"
            title={paletteKey ? `Command palette (${paletteKey})` : "Command palette"}
            onClick={() => openCommandPalette()}
          >
            <Command aria-hidden />
          </Button>
          <Button size="sm" variant="ghost-muted" render={<Link to="/settings" />}>
            Settings
          </Button>
        </div>
        <div className="flex items-center gap-1.5 px-3 pb-2" role="group" aria-label="Filter">
          <FilterChip pressed={filter === "all"} onClick={() => setFilter("all")}>
            All
          </FilterChip>
          <FilterChip pressed={filter === "needs-you"} onClick={() => setFilter("needs-you")}>
            Needs you
            {needsYou.length > 0 ? <span className="font-mono tabular-nums">{needsYou.length}</span> : null}
          </FilterChip>
        </div>
        <label className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-input bg-background px-2.5 pointer-coarse:h-11">
          <Search className="size-3.5 text-muted-foreground" aria-hidden />
          <input
            type="search"
            aria-label="Search threads"
            placeholder="Search"
            className="h-8 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-placeholder sm:text-sm pointer-coarse:h-full"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
          />
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-2">
          <PushOnboarding className="mx-3 mb-2" />
          {!loaded ? <p className="px-4 text-sm text-muted-foreground">Loading threads…</p> : null}
          {loaded && flat !== null ? (
            flat.length === 0 ? (
              <p className="px-4 py-2 text-sm text-muted-foreground">{query.trim() ? "No matches." : "Nothing needs you."}</p>
            ) : (
              <ul aria-label={query.trim() ? "Search results" : "Needs you"}>
                {flat.map((t) => (
                  <SidebarThreadRow key={t.id} thread={t} projectLabel={projects[t.projectId]?.label} />
                ))}
              </ul>
            )
          ) : null}
          {loaded && flat === null ? (
            tree.length === 0 ? (
              <p className="px-4 text-sm text-muted-foreground">No threads.</p>
            ) : (
              <ProjectTree tree={tree} desktop={desktop} projectActions={projectActions} />
            )
          ) : null}
        </div>
        <div className="border-t px-4 py-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]">
          <Link to="/archived" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground pointer-coarse:min-h-11">
            Archived{archivedCount > 0 ? ` (${archivedCount})` : ""}
          </Link>
        </div>
      </nav>
      <ThreadRowMenu
        thread={menuThread}
        anchor={menu?.anchor ?? null}
        onClose={() => setMenu(null)}
        run={run}
        onRename={(id) => setTimeout(() => setRenamingId(id), 0)}
        onPickSnooze={(id) => setSnoozePick(id)}
      />
      <ProjectRowMenu
        project={projectMenu ? (projects[projectMenu.projectId] ?? null) : null}
        anchor={projectMenu?.anchor ?? null}
        onClose={() => setProjectMenu(null)}
        onRename={(id) => setTimeout(() => setRenamingProjectId(id), 0)}
      />
      <CustomSnoozeDialog
        open={snoozePick !== null}
        onOpenChange={(open) => {
          if (!open) setSnoozePick(null);
        }}
        onSnooze={(until) => {
          if (snoozePick) run({ type: "thread.snooze", threadId: snoozePick, until });
        }}
      />
    </SidebarRowContext.Provider>
  );
}

function FilterChip({ pressed, onClick, children }: { pressed: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs pointer-coarse:h-11 pointer-coarse:px-4 pointer-coarse:text-sm",
        pressed ? "border-you bg-you-soft text-foreground" : "border-transparent text-muted-foreground hover:bg-sidebar-row-hover",
      )}
    >
      {children}
    </button>
  );
}

// ── The project tree, with drag ─────────────────────────────────────────────────────────────────

interface ProjectActions {
  renamingId: string | null;
  openMenu(projectId: string, anchor: HTMLElement): void;
  endRename(): void;
}

function ProjectTree({ tree, desktop, projectActions }: { tree: SidebarProjectNode[]; desktop: boolean; projectActions: ProjectActions }) {
  // Desktop only; a phone swipes instead. No keyboard sensor: Space opens the row menu.
  const pointer = useSensor(PointerSensor, { activationConstraint: { distance: 6 } });
  const sensors = useSensors(...(desktop ? [pointer] : []));
  const onDragStart = (e: DragStartEvent) => useSidebarDrag.setState({ dragging: String(e.active.id), overZone: null });
  const onDragOver = (e: DragOverEvent) => useSidebarDrag.setState({ overZone: zoneFor(tree, e.over ? String(e.over.id) : null) });
  const onDragEnd = (e: DragEndEvent) => void handleSidebarDrop(String(e.active.id), e.over ? String(e.over.id) : null);
  const onDragCancel = () => useSidebarDrag.setState({ dragging: null, overZone: null });
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {tree.map((node) => (
        <ProjectBlock key={node.project.id} node={node} desktop={desktop} actions={projectActions} />
      ))}
    </DndContext>
  );
}

function ProjectBlock({ node, desktop, actions }: { node: SidebarProjectNode; desktop: boolean; actions: ProjectActions }) {
  const { project } = node;
  const collapsed = useSidebarPrefs((s) => s.collapsedProjects.includes(project.id));
  const toggle = useSidebarPrefs((s) => s.toggleProject);
  const dragging = useSidebarDrag((s) => s.dragging !== null);
  const hasPins = node.shelves.pinned.length > 0;
  // A touch long press is the project row's right click (Rename).
  const press = useLongPress((el) => actions.openMenu(project.id, el));
  return (
    <section aria-label={project.label} data-project-id={project.id} className={cn(node.nested && "ml-3 border-l border-line/60")}>
      <div className="group/project flex items-center pr-2">
        {actions.renamingId === project.id ? (
          <ProjectRenameField label={project.label} onDone={actions.endRename} onCommit={(label) => void renameProject(project.id, label)} />
        ) : (
          <button
            type="button"
            data-project-row=""
            aria-expanded={!collapsed}
            onClick={() => {
              if (!press.consumeClick()) toggle(project.id);
            }}
            onPointerDown={press.onPointerDown}
            onPointerMove={press.onPointerMove}
            onPointerUp={press.cancel}
            onPointerCancel={press.cancel}
            onContextMenu={(e) => {
              e.preventDefault();
              press.cancel();
              actions.openMenu(project.id, e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (e.key === " ") {
                e.preventDefault();
                actions.openMenu(project.id, e.currentTarget);
              }
            }}
            className="flex min-w-0 flex-1 touch-pan-y items-center gap-1.5 py-1.5 pl-3 text-left text-xs font-medium text-muted-foreground outline-none select-none [-webkit-touch-callout:none] hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:text-sm"
          >
            {collapsed ? <ChevronRight className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
            {node.nested ? <GitBranch className="size-3.5" role="img" aria-label="Worktree" /> : null}
            <span className="min-w-0 flex-1 truncate">{project.label}</span>
            <span className="font-mono text-2xs tabular-nums">{project.number}</span>
            {node.rollUp ? <ThreadStatusDot status={node.rollUp} showElapsed={false} /> : null}
          </button>
        )}
        {/* T14: a new thread in this project. */}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`New thread in ${project.label}`}
          className={cn("ml-1", desktop && "opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100")}
          render={<Link to="/new" search={{ project: project.id }} />}
        >
          <Plus aria-hidden />
        </Button>
      </div>
      {collapsed ? null : (
        <>
          {hasPins || dragging ? <ShelfList node={node} section="pinned" desktop={desktop} showLabel /> : null}
          <ShelfList node={node} section="active" desktop={desktop} showLabel={dragging || hasPins} />
          <CollapsedShelf node={node} section="snoozed" desktop={desktop} />
          <CollapsedShelf node={node} section="settled" desktop={desktop} />
          {node.worktrees.map((w) => (
            <ProjectBlock key={w.project.id} node={w} desktop={desktop} actions={actions} />
          ))}
        </>
      )}
    </section>
  );
}

function SectionZone({
  projectId,
  section,
  children,
  className,
}: {
  projectId: string;
  section: SidebarSection;
  children: ReactNode;
  className?: string;
}) {
  const id = sectionDropId(projectId, section);
  const { setNodeRef } = useDroppable({ id });
  const over = useSidebarDrag((s) => s.overZone === id);
  const dragging = useSidebarDrag((s) => s.dragging !== null);
  return (
    <div
      ref={setNodeRef}
      data-drop-zone={id}
      data-over={over || undefined}
      className={cn("border-l-2 border-transparent", dragging && over && "border-you", className)}
    >
      {children}
    </div>
  );
}

function ShelfList({
  node,
  section,
  desktop,
  showLabel,
}: {
  node: SidebarProjectNode;
  section: "pinned" | "active";
  desktop: boolean;
  showLabel: boolean;
}) {
  const threads = node.shelves[section];
  if (threads.length === 0 && !showLabel) return null;
  return (
    <SectionZone projectId={node.project.id} section={section}>
      {showLabel ? <div className="px-4 pt-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground">{SECTION_LABEL[section]}</div> : null}
      <SortableContext id={`${node.project.id}:${section}`} items={threads.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <ul aria-label={`${node.project.label} ${SECTION_LABEL[section]}`}>
          {threads.map((t) => (
            <SortableThreadRow key={t.id} thread={t} draggable={desktop} />
          ))}
        </ul>
      </SortableContext>
    </SectionZone>
  );
}

function CollapsedShelf({ node, section, desktop }: { node: SidebarProjectNode; section: "snoozed" | "settled"; desktop: boolean }) {
  const threads = node.shelves[section];
  const open = useSidebarPrefs((s) => s.openSections.includes(`${node.project.id}:${section}`));
  const toggle = useSidebarPrefs((s) => s.toggleSection);
  const dragging = useSidebarDrag((s) => s.dragging !== null);
  const zone = sectionDropId(node.project.id, section);
  const shake = useSidebarDrag((s) => s.shake === zone);
  const rollUp = useMemo(() => rollUpStatus(threads), [threads]);
  useEffect(() => {
    if (!shake) return;
    const id = setTimeout(() => useSidebarDrag.setState({ shake: null }), 400);
    return () => clearTimeout(id);
  }, [shake]);
  if (threads.length === 0 && !dragging) return null;
  const label = SECTION_LABEL[section];
  return (
    <SectionZone projectId={node.project.id} section={section}>
      <button
        type="button"
        aria-expanded={open}
        data-shake={shake || undefined}
        onClick={() => toggle(node.project.id, section)}
        className={cn(
          "flex w-full items-center gap-1.5 px-4 py-1 text-left text-xs text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:text-sm",
          shake && "animate-shake-once",
        )}
      >
        {open ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
        <span className="flex-1">
          {label} <span className="font-mono tabular-nums">{threads.length}</span>
        </span>
        {rollUp && (rollUp === "approval" || rollUp === "input" || rollUp === "failed" || rollUp === "done") ? (
          <ThreadStatusDot status={rollUp} showElapsed={false} />
        ) : null}
      </button>
      {open ? (
        <SortableContext id={`${node.project.id}:${section}`} items={threads.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <ul aria-label={`${node.project.label} ${label}`}>
            {threads.map((t) => (
              <SortableThreadRow key={t.id} thread={t} draggable={desktop} />
            ))}
          </ul>
        </SortableContext>
      ) : null}
    </SectionZone>
  );
}
