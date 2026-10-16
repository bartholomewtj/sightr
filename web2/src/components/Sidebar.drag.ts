/**
 * Desktop drag between shelves (T10). Same job and name as T3 Code's
 * apps/web/src/components/Sidebar.drag.ts; Sightr's own code on the same library (@dnd-kit, T3's pins).
 *
 * Rows are sortable items (id = thread id). Each shelf of each project is also a droppable zone
 * (`sectionDropId`): its label while a drag is on, and the Snoozed and Settled headers always. A drop
 * resolves to a project, a section and an index, and `planSidebarDrop` (Sidebar.logic.ts) turns it into
 * one command. Drops across projects mean nothing.
 */
import { arrayMove } from "@dnd-kit/sortable";
import { create } from "zustand";

import type { Thread } from "@shared/v2/contracts";
import {
  buildProjectTree,
  flattenProjectTree,
  planSidebarDrop,
  SIDEBAR_SECTIONS,
  type SidebarDropPlan,
  type SidebarProjectNode,
  type SidebarSection,
} from "@/components/Sidebar.logic";
import { showToast } from "@/components/toast";
import { applyPending, performThreadCommand, usePendingShelf } from "@/state/sidebar";
import { useShell } from "@/stream/stores";

const SECTION_PREFIX = "section:";

export function sectionDropId(projectId: string, section: SidebarSection): string {
  return `${SECTION_PREFIX}${section}:${projectId}`;
}

export function parseSectionDropId(id: string): { projectId: string; section: SidebarSection } | null {
  if (!id.startsWith(SECTION_PREFIX)) return null;
  const rest = id.slice(SECTION_PREFIX.length);
  const colon = rest.indexOf(":");
  const section = rest.slice(0, colon) as SidebarSection;
  if (colon < 0 || !SIDEBAR_SECTIONS.includes(section)) return null;
  return { projectId: rest.slice(colon + 1), section };
}

export interface ResolvedDrop {
  thread: Thread;
  from: SidebarSection;
  to: SidebarSection;
  pinnedOrderAfterDrop: string[];
  pinOrders: Map<string, number | undefined>;
}

function locate(nodes: readonly SidebarProjectNode[], threadId: string): { node: SidebarProjectNode; section: SidebarSection; index: number } | null {
  for (const node of nodes) {
    for (const section of SIDEBAR_SECTIONS) {
      const index = node.shelves[section].findIndex((t) => t.id === threadId);
      if (index >= 0) return { node, section, index };
    }
  }
  return null;
}

/** Where a drop of `activeId` over `overId` lands; null for a drop that means nothing. */
export function resolveSidebarDrop(tree: readonly SidebarProjectNode[], activeId: string, overId: string): ResolvedDrop | null {
  const nodes = flattenProjectTree(tree);
  const source = locate(nodes, activeId);
  if (!source) return null;
  let target: { projectId: string; section: SidebarSection; index: number | null } | null = null;
  const zone = parseSectionDropId(overId);
  if (zone) {
    target = { ...zone, index: null };
  } else {
    const over = locate(nodes, overId);
    if (over) target = { projectId: over.node.project.id, section: over.section, index: over.index };
  }
  if (!target || target.projectId !== source.node.project.id) return null;

  const pinned = source.node.shelves.pinned;
  const ids = pinned.map((t) => t.id);
  let order = ids;
  if (target.section === "pinned") {
    if (source.section === "pinned") {
      order = target.index === null ? arrayMove(ids, source.index, 0) : arrayMove(ids, source.index, target.index);
    } else {
      order = [...ids];
      order.splice(target.index ?? 0, 0, activeId);
    }
  }
  return {
    thread: source.node.shelves[source.section][source.index]!,
    from: source.section,
    to: target.section,
    pinnedOrderAfterDrop: order,
    pinOrders: new Map(pinned.map((t) => [t.id, t.pinOrder])),
  };
}

// ── Drag UI state ───────────────────────────────────────────────────────────────────────────────

interface DragUi {
  /** The thread being dragged. */
  dragging: string | null;
  /** The section zone under the pointer (`sectionDropId`), for its accent border. */
  overZone: string | null;
  /** A Snoozed header that refused a drop; it shakes once. */
  shake: string | null;
}

export const useSidebarDrag = create<DragUi>(() => ({ dragging: null, overZone: null, shake: null }));

export const SNOOZE_DROP_MESSAGE = "Pick a snooze time from the menu";

/** The zone a pointer over `overId` highlights: the section of the row or zone under it. */
export function zoneFor(tree: readonly SidebarProjectNode[], overId: string | null): string | null {
  if (!overId) return null;
  if (parseSectionDropId(overId)) return overId;
  const over = locate(flattenProjectTree(tree), overId);
  return over ? sectionDropId(over.node.project.id, over.section) : null;
}

/** The current tree, as the sidebar draws it (pending commands applied). */
export function currentTree(): SidebarProjectNode[] {
  const shell = useShell.getState();
  const threads = applyPending(shell.threads, usePendingShelf.getState().pending);
  return buildProjectTree(Object.values(shell.projects), Object.values(threads));
}

/** Run a finished drag: one command, a refusal toast, or nothing. Returns the plan (tests read it). */
export async function handleSidebarDrop(activeId: string, overId: string | null): Promise<SidebarDropPlan> {
  useSidebarDrag.setState({ dragging: null, overZone: null });
  if (!overId || overId === activeId) return { kind: "none" };
  const tree = currentTree();
  const drop = resolveSidebarDrop(tree, activeId, overId);
  if (!drop) return { kind: "none" };
  const plan = planSidebarDrop(drop);
  if (plan.kind === "refused-snooze") {
    useSidebarDrag.setState({ shake: sectionDropId(drop.thread.projectId, "snoozed") });
    showToast(SNOOZE_DROP_MESSAGE);
  } else if (plan.kind === "command") {
    await performThreadCommand(plan.command);
  }
  return plan;
}
