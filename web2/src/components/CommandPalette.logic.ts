// Adapted from T3 Code apps/web/src/components/CommandPalette.logic.ts @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: Sightr's threads (herd panes) and projects (herdr workspaces) in place of T3's; groups are
// Needs you / Recent threads / Actions with an empty query and Threads / Projects / Actions with one;
// a subsequence match ranks below T3's token match; actions carry an `applies` test so only the ones
// that fit the current thread are offered. Filtering, ranking, rows and the highlighted-item lookup
// are T3's (Effect's Array/Result replaced by plain arrays). No browse, submenu or add-project modes.
import { type ReactNode } from "react";

import type { KeybindingCommand } from "@t3tools/contracts";
import type { Project, Thread } from "@shared/v2/contracts";

import { compareActive, isNeedsYou } from "./Sidebar.logic";

export const RECENT_THREAD_LIMIT = 12;
export const ITEM_ICON_CLASS = "size-4 text-icon-muted";

/** T3's `normalizeSearchText` (apps/web/src/lib/utils.ts). */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface CommandPaletteItem {
  readonly kind: "action";
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly timestamp?: string;
  readonly searchRecency?: number;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly titleLeadingContent?: ReactNode;
  readonly titleTrailingContent?: ReactNode;
  readonly shortcutCommand?: KeybindingCommand;
  readonly secondary?: boolean;
}

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly keepOpen?: boolean;
  readonly run: () => Promise<void> | void;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem>;
}

export type CommandPaletteRow =
  | { readonly kind: "label"; readonly key: string; readonly label: string; readonly first: boolean }
  | { readonly kind: "item"; readonly key: string; readonly item: CommandPaletteActionItem; readonly itemIndex: number | null };

export function buildCommandPaletteRows(groups: ReadonlyArray<CommandPaletteGroup>) {
  const rows: CommandPaletteRow[] = [];
  const itemValues: string[] = [];
  const rowIndexByItemIndex: number[] = [];
  for (const group of groups) {
    if (group.label) rows.push({ kind: "label", key: `group:${group.value}`, label: group.label, first: rows.length === 0 });
    for (const item of group.items) {
      const itemIndex = item.disabled ? null : itemValues.length;
      if (itemIndex !== null) {
        itemValues.push(item.value);
        rowIndexByItemIndex.push(rows.length);
      }
      rows.push({ kind: "item", key: `${group.value}:${item.value}`, item, itemIndex });
    }
  }
  return { rows, itemValues, rowIndexByItemIndex };
}

export function findHighlightedCommandPaletteItem(
  groups: ReadonlyArray<CommandPaletteGroup>,
  highlightedItemValue: string | null,
): CommandPaletteActionItem | null {
  if (highlightedItemValue === null) return null;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.value === highlightedItemValue && !item.disabled) return item;
    }
  }
  return null;
}

// ── Threads and projects ────────────────────────────────────────────────────────────────────────

export function buildThreadActionItems(input: {
  threads: Iterable<Thread>;
  projects: Readonly<Record<string, Project>>;
  activeThreadId?: string;
  icon: ReactNode;
  renderLeadingContent?: (thread: Thread) => ReactNode;
  formatTimestamp?: (ms: number) => string;
  runThread: (thread: Thread) => Promise<void> | void;
  /** Most recent first by `lastActivityAt`, cut to this many. */
  limit?: number;
}): CommandPaletteActionItem[] {
  const threads = [...input.threads].filter((t) => t.shelf !== "archived").sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const visible = input.limit === undefined ? threads : threads.slice(0, input.limit);
  return visible.map((thread) => threadItem(thread, input));
}

function threadItem(
  thread: Thread,
  input: Pick<Parameters<typeof buildThreadActionItems>[0], "projects" | "activeThreadId" | "icon" | "renderLeadingContent" | "formatTimestamp" | "runThread">,
): CommandPaletteActionItem {
  const projectTitle = input.projects[thread.projectId]?.label;
  const descriptionParts: string[] = [];
  if (projectTitle) descriptionParts.push(projectTitle);
  descriptionParts.push(thread.harness);
  if (thread.id === input.activeThreadId) descriptionParts.push("Current thread");
  const leading = input.renderLeadingContent?.(thread);
  return {
    kind: "action",
    value: `thread:${thread.id}`,
    // Title first: a match there ranks highest (T3's `searchRecency` rule).
    searchTerms: [thread.title, projectTitle ?? "", thread.harness],
    title: thread.title || "Untitled thread",
    description: descriptionParts.join(" · "),
    ...(input.formatTimestamp ? { timestamp: input.formatTimestamp(thread.lastActivityAt) } : {}),
    searchRecency: thread.lastActivityAt,
    icon: input.icon,
    ...(leading ? { titleLeadingContent: leading } : {}),
    run: () => input.runThread(thread),
  };
}

/** "Needs you" threads, worst first (the sidebar's order). */
export function buildNeedsYouItems(input: Parameters<typeof buildThreadActionItems>[0]): CommandPaletteActionItem[] {
  return [...input.threads].filter(isNeedsYou).sort(compareActive).map((thread) => threadItem(thread, input));
}

export function buildProjectActionItems(input: {
  projects: Iterable<Project>;
  valuePrefix: string;
  titleFor?: (project: Project) => string;
  icon: (project: Project) => ReactNode;
  runProject: (project: Project) => Promise<void> | void;
  shortcutCommand?: KeybindingCommand;
}): CommandPaletteActionItem[] {
  return [...input.projects]
    .filter((p) => p.closedAt === undefined)
    .sort((a, b) => a.order - b.order || a.number - b.number)
    .map((project) => ({
      kind: "action" as const,
      value: `${input.valuePrefix}:${project.id}`,
      searchTerms: [input.titleFor?.(project) ?? project.label, project.label],
      title: input.titleFor?.(project) ?? project.label,
      icon: input.icon(project),
      ...(input.shortcutCommand !== undefined ? { shortcutCommand: input.shortcutCommand } : {}),
      run: () => input.runProject(project),
    }));
}

// ── Actions ─────────────────────────────────────────────────────────────────────────────────────

/** What the palette knows about "now" when it decides which actions apply. */
export interface CommandPaletteContext {
  readonly thread: Thread | null;
  readonly desktop: boolean;
  readonly readOnly: boolean;
}

export interface CommandPaletteActionSpec {
  readonly value: string;
  readonly title: string;
  readonly searchTerms?: ReadonlyArray<string>;
  readonly icon: ReactNode;
  readonly shortcutCommand?: KeybindingCommand;
  readonly applies?: (ctx: CommandPaletteContext) => boolean;
  readonly run: () => Promise<void> | void;
}

/** Only the actions that apply now (T13: "Actions (only those that apply now)"). */
export function buildActionItems(specs: ReadonlyArray<CommandPaletteActionSpec>, ctx: CommandPaletteContext): CommandPaletteActionItem[] {
  return specs
    .filter((spec) => spec.applies?.(ctx) ?? true)
    .map((spec) => ({
      kind: "action" as const,
      value: `action:${spec.value}`,
      searchTerms: [spec.title, ...(spec.searchTerms ?? [])],
      title: spec.title,
      icon: spec.icon,
      ...(spec.shortcutCommand ? { shortcutCommand: spec.shortcutCommand } : {}),
      run: spec.run,
    }));
}

/** Context tests the action table uses. */
export const applies = {
  thread: (ctx: CommandPaletteContext) => ctx.thread !== null,
  writableThread: (ctx: CommandPaletteContext) => ctx.thread !== null && !ctx.readOnly && ctx.thread.shelf !== "archived",
  running: (ctx: CommandPaletteContext) =>
    ctx.thread !== null && !ctx.readOnly && ctx.thread.status === "working" && ctx.thread.capabilities.canInterrupt,
  canMarkUnread: (ctx: CommandPaletteContext) => ctx.thread !== null && ctx.thread.shelf !== "archived" && !ctx.thread.unreadDone,
  shelf:
    (...shelves: Thread["shelf"][]) =>
    (ctx: CommandPaletteContext) =>
      ctx.thread !== null && !ctx.readOnly && shelves.includes(ctx.thread.shelf),
  desktop: (ctx: CommandPaletteContext) => ctx.desktop,
};

// ── Filtering and ranking (T3) ──────────────────────────────────────────────────────────────────

/** True when every character of `needle` appears in `haystack` in order. */
export function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const ch of haystack) {
    if (ch === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return needle.length === 0;
}

function rankSearchFieldMatch(field: string, normalizedQuery: string, queryTokens: ReadonlyArray<string>): number {
  const normalizedField = normalizeSearchText(field);
  if (normalizedField.length === 0 || !queryTokens.every((token) => normalizedField.includes(token))) {
    return Number.NEGATIVE_INFINITY;
  }
  if (normalizedField === normalizedQuery) return 3;
  if (normalizedField.startsWith(normalizedQuery)) return 2;
  if (normalizedField.includes(normalizedQuery)) return 1;
  return 0;
}

function rankCommandPaletteItemMatch(item: CommandPaletteActionItem, normalizedQuery: string, queryTokens: ReadonlyArray<string>): number {
  const terms = item.searchTerms.filter((term) => term.length > 0);
  if (terms.length === 0) return 0;
  for (const [index, field] of terms.entries()) {
    const fieldRank = rankSearchFieldMatch(field, normalizedQuery, queryTokens);
    if (fieldRank !== Number.NEGATIVE_INFINITY) {
      if (index === 0 && item.searchRecency !== undefined) return 1_000 + Number(fieldRank === 3);
      return 1_000 - index * 100 + fieldRank;
    }
  }
  return 0;
}

/** Rank of a subsequence-only match ("fxbld" for "Fix the build"): below every token match. */
const SUBSEQUENCE_RANK = -1;

export function filterCommandPaletteGroups(input: {
  activeGroups: ReadonlyArray<CommandPaletteGroup>;
  query: string;
  projectSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  threadSearchItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const isActionsFilter = input.query.startsWith(">");
  const searchQuery = isActionsFilter ? input.query.slice(1) : input.query;
  const normalizedQuery = normalizeSearchText(searchQuery);

  if (normalizedQuery.length === 0) {
    if (isActionsFilter) return input.activeGroups.filter((group) => group.value === "actions");
    return [...input.activeGroups];
  }
  const queryTokens = normalizedQuery.split(" ");
  const compactQuery = normalizedQuery.replace(/ /g, "");

  // With a query the thread lists (Needs you, Recent) give way to the full thread search (T3 drops
  // its recent-threads group the same way); actions stay.
  const baseGroups = input.activeGroups.filter((group) => group.value === "actions");

  const searchableGroups: CommandPaletteGroup[] = [];
  if (!isActionsFilter) {
    if (input.threadSearchItems.length > 0) searchableGroups.push({ value: "threads-search", label: "Threads", items: input.threadSearchItems });
    if (input.projectSearchItems.length > 0) searchableGroups.push({ value: "projects-search", label: "Projects", items: input.projectSearchItems });
  }
  searchableGroups.push(...baseGroups);

  return searchableGroups.flatMap((group) => {
    const ranked: { item: CommandPaletteActionItem; index: number; rank: number }[] = [];
    group.items.forEach((item, index) => {
      const haystack = normalizeSearchText(item.searchTerms.join(" "));
      if (queryTokens.every((token) => haystack.includes(token))) {
        ranked.push({ item, index, rank: rankCommandPaletteItemMatch(item, normalizedQuery, queryTokens) });
      } else if (compactQuery.length >= 2 && isSubsequence(compactQuery, normalizeSearchText(item.searchTerms[0] ?? "").replace(/ /g, ""))) {
        ranked.push({ item, index, rank: SUBSEQUENCE_RANK });
      }
    });
    const items = ranked
      .sort(
        (left, right) =>
          Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
          right.rank - left.rank ||
          (right.item.searchRecency ?? 0) - (left.item.searchRecency ?? 0) ||
          left.index - right.index,
      )
      .map((entry) => entry.item);
    return items.length === 0 ? [] : [{ value: group.value, label: group.label, items }];
  });
}

/** The groups with an empty query: Needs you, then recent threads, then actions. */
export function buildRootGroups(input: {
  needsYouItems: ReadonlyArray<CommandPaletteActionItem>;
  recentThreadItems: ReadonlyArray<CommandPaletteActionItem>;
  actionItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const groups: CommandPaletteGroup[] = [];
  const needsYou = new Set(input.needsYouItems.map((i) => i.value));
  if (input.needsYouItems.length > 0) groups.push({ value: "needs-you", label: "Needs you", items: input.needsYouItems });
  const recent = input.recentThreadItems.filter((i) => !needsYou.has(i.value));
  if (recent.length > 0) groups.push({ value: "recent-threads", label: "Recent threads", items: recent });
  if (input.actionItems.length > 0) groups.push({ value: "actions", label: "Actions", items: input.actionItems });
  return groups;
}

export function getCommandPaletteInputPlaceholder(): string {
  return "Search threads, projects and actions...";
}
