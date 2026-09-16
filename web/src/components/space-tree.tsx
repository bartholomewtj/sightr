import { useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { ChevronDown, ChevronRight, FolderPlus, GitBranch, LayoutGrid, Plug, Plus, Search, TerminalSquare, WifiOff, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/section-header";
import { AgentCard, RowMoreButton } from "@/components/agent-card";
import { StatusDot } from "@/components/status-badge";
import { SpaceActionsSheet } from "@/components/space-actions-sheet";
import { TabActionsSheet } from "@/components/tab-actions-sheet";
import { PaneActionsSheet } from "@/components/pane-actions-sheet";
import { PushOnboarding } from "@/components/push-onboarding";
import { contextMenuProps, type MenuPoint } from "@/lib/menu-anchor";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import {
  clusterSpaces,
  filterClusters,
  groupPanesByTab,
  isWorktreeFamily,
  spaceBranchLine,
  spaceLastSeenMap,
  spaceRowLabel,
  spaceTriageMap,
  worstBucket,
} from "@/lib/spaces";
import * as api from "@/lib/api";
import { setStatus } from "@/lib/status";
import { TRIAGE_STATUS, sectionHeaderProps, shownStatus, triage } from "@/lib/triage";
import { clockTime, timeAgo } from "@/lib/format";
import { homePath, panePath } from "@/lib/nav";
import { paneRowLabel } from "@/lib/pane-name";
import { STATUS_LABEL } from "@/lib/types";
import type { AgentView, ClosedWorktree, TabView, WorkspaceView } from "@/lib/types";

interface TreeRowButtonProps {
  onClick?: () => void;
  onMenu?: (at: MenuPoint) => void;
  className?: string;
  children: ReactNode;
  disabled?: boolean;
}

type WorktreeConnectorGlyph = "fork" | "end" | "line" | "blank";

function WorktreeConnector({
  glyph,
  tallRow = false,
}: {
  glyph: WorktreeConnectorGlyph;
  /** When the row has a second branch line, nudge the glyph down to the title row. */
  tallRow?: boolean;
}) {
  const symbol =
    glyph === "fork" ? "├─" : glyph === "end" ? "└─" : glyph === "line" ? "│" : "";
  return (
    <span
      data-testid="worktree-connector"
      className={cn(
        "flex w-7 shrink-0 items-center justify-center font-mono text-[11px] leading-none text-muted-foreground/70",
        tallRow && "mt-3.5",
      )}
      aria-hidden
    >
      {symbol}
    </span>
  );
}

function TreeRowButton({
  onClick,
  onMenu,
  className,
  children,
  disabled,
}: TreeRowButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      {...contextMenuProps(onMenu)}
      className={cn(
        "flex min-w-0 flex-1 select-none flex-row items-center gap-2.5 text-left transition-transform [-webkit-touch-callout:none]",
        !disabled && "active:scale-[0.99]",
        disabled && "cursor-default",
        className,
      )}
    >
      {children}
    </button>
  );
}

export interface SpaceTreeProps {
  workspaces: WorkspaceView[];
  tabs: TabView[];
  agents: AgentView[];
  shellPanes?: AgentView[];
  onNewSpace: () => void;
  onNewTab: (workspaceId: string) => void;
  readOnly?: boolean;
  onRenamed?: () => void;
  /** The snapshot on screen is stale — an empty tree then means "we don't know", never "no spaces". */
  error?: boolean;
  lastSeenAt?: number;
  currentPaneId?: string;
}

export function SpaceTree({
  workspaces,
  tabs,
  agents,
  shellPanes = [],
  onNewSpace,
  onNewTab,
  readOnly,
  onRenamed,
  error = false,
  lastSeenAt,
  currentPaneId,
}: SpaceTreeProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);

  const { prefs, setSpaceOpen, setTabOpen } = useDashPrefs();

  const [sheetSpace, setSheetSpace] = useState<WorkspaceView | null>(null);
  const [sheetTab, setSheetTab] = useState<TabView | null>(null);
  const [sheetPane, setSheetPane] = useState<AgentView | null>(null);
  const [sheetAnchor, setSheetAnchor] = useState<MenuPoint | null>(null);

  const actionsEnabled = !!onRenamed;

  const panes = [...agents, ...shellPanes];
  // Single pass derivations
  const lastSeen = spaceLastSeenMap(panes);
  const worstBySpace = spaceTriageMap(agents);
  const blockedSpaces = [...worstBySpace.values()].filter((b) => b === "needs").length;
  const inbox = triage(agents).filter((section) => section.key === "needs" || section.key === "ready");

  // Fixed order: Herdr's workspace order, packed into worktree groups (parent + indented
  // linked children + closed checkouts). No recency sort, no blocked-first regroup.
  const clusters = filterClusters(clusterSpaces(workspaces), query);
  const visibleCount = query.trim()
    ? clusters.reduce((n, c) => n + (c.parent ? 1 : 0) + c.children.length, 0)
    : workspaces.length;

  async function openClosed(sourceId: string | undefined, closed: ClosedWorktree) {
    try {
      const res = await api.openWorktree({
        workspaceId: sourceId,
        path: closed.path,
        ...(sourceId ? {} : { cwd: closed.path }),
      });
      if (!res.ok) {
        setStatus(res.error, "error");
        return;
      }
      onRenamed?.();
      navigate(panePath(res.pane.paneId));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    }
  }

  function handleSpaceRowClick(
    w: WorkspaceView,
    tabGroups: ReturnType<typeof groupPanesByTab>,
    isSpaceExpanded: boolean,
  ) {
    if (tabGroups.length === 1) {
      const singleTab = tabGroups[0]!;
      if (singleTab.panes.length === 1) {
        navigate(panePath(singleTab.panes[0]!.paneId));
        return;
      } else if (singleTab.panes.length >= 2) {
        setSpaceOpen(w.workspaceId, true);
        setTabOpen(singleTab.tabId, true);
        return;
      } else {
        setSpaceOpen(w.workspaceId, !isSpaceExpanded);
        return;
      }
    } else {
      setSpaceOpen(w.workspaceId, !isSpaceExpanded);
    }
  }

  function handleTabRowClick(
    tabId: string,
    tabPanes: AgentView[],
    isTabExpanded: boolean,
  ) {
    if (tabPanes.length === 1) {
      navigate(panePath(tabPanes[0]!.paneId));
    } else if (tabPanes.length >= 2) {
      setTabOpen(tabId, !isTabExpanded);
    }
  }

  return (
    <section className="flex flex-col gap-2 px-3 py-4">
      <PushOnboarding className="mb-1" />
      {inbox.map((section) => section.agents.length === 0 ? null : (
        <div key={section.key} className="flex flex-col gap-1" data-testid={`${section.key}-inbox`}>
          <SectionHeader {...sectionHeaderProps(section)} />
          <div className="flex flex-col divide-y divide-border/60">
            {section.agents.map((agent) => (
              <AgentCard
                key={agent.paneId}
                agent={agent}
                density="card"
                statusStyle="badge"
                scope="herd"
                onClick={() => navigate(panePath(agent.paneId))}
                onMenu={actionsEnabled ? (at) => { setSheetAnchor(at); setSheetPane(agent); } : undefined}
                onMore={actionsEnabled ? (at) => { setSheetAnchor(at); setSheetPane(agent); } : undefined}
              />
            ))}
          </div>
        </div>
      ))}

      <SectionHeader
        label="Spaces"
        count={visibleCount}
        trailing={
          <>
            {blockedSpaces > 0 && (
              <span
                className="flex items-center gap-1 text-[11px] font-semibold tabular-nums text-status-blocked"
                aria-label={`${blockedSpaces} ${blockedSpaces === 1 ? "space needs" : "spaces need"} you`}
              >
                <span className="size-2 rounded-full bg-status-blocked" aria-hidden />
                {blockedSpaces}
              </span>
            )}
            {workspaces.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  if (filterOpen || query) {
                    setFilterOpen(false);
                    setQuery("");
                  } else {
                    setFilterOpen(true);
                  }
                }}
                aria-label="Filter spaces"
                aria-expanded={filterOpen}
                className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
              >
                {filterOpen || query ? <X className="size-4" /> : <Search className="size-4" />}
              </button>
            )}
            <button
              type="button"
              onClick={onNewSpace}
              aria-label="New space"
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
            >
              <FolderPlus className="size-4" />
            </button>
          </>
        }
      />

      {filterOpen && (
        <label className="flex items-center gap-2 rounded-xl border-2 border-foreground bg-card px-3 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter spaces…"
            aria-label="Filter spaces"
            className="min-h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
      )}

      <div id="spaces-body" className="flex flex-col divide-y divide-border/60">

        {workspaces.length === 0 ? (
          error ? (
            <p className="flex items-center justify-center gap-2 px-1 py-6 text-center text-sm text-muted-foreground">
              <WifiOff className="size-4" />
              {lastSeenAt === undefined
                ? "Disconnected"
                : `Disconnected — last seen ${clockTime(lastSeenAt)}`}
            </p>
          ) : (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">No spaces yet.</p>
          )
        ) : clusters.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">
            No space matches “{query}”.
          </p>
        ) : (
          clusters.map((cluster) => {
            const family = isWorktreeFamily(cluster);
            const openRows = cluster.parent ? [cluster.parent, ...cluster.children] : cluster.children;
            return (
              <div
                key={cluster.key}
                className={cn(
                  "flex flex-col",
                  family && "my-1 overflow-hidden rounded-lg ring-1 ring-inset ring-border/50",
                )}
              >
                {!cluster.parent && cluster.repoName ? (
                  <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <GitBranch className="size-3 shrink-0" aria-hidden />
                    {cluster.repoName}
                  </div>
                ) : null}
                {openRows.map((w, rowIndex) => {
            const linkedChild = cluster.parent ? rowIndex > 0 : !!cluster.repoName;
            const rowLabel = spaceRowLabel(w, linkedChild);
            const branchLine = spaceBranchLine(w, linkedChild);
            const isLastOpen = rowIndex === openRows.length - 1 && cluster.closed.length === 0;
            const connector: WorktreeConnectorGlyph | null = !family
              ? null
              : linkedChild
                ? isLastOpen
                  ? "end"
                  : "fork"
                : isLastOpen || rowIndex === 0
                  ? "blank"
                  : "line";
            const worstBucketKey = worstBySpace.get(w.workspaceId);
            const status = worstBucketKey ? TRIAGE_STATUS[worstBucketKey] : null;
            const blocked = worstBucketKey === "needs";
            const seen = lastSeen.get(w.workspaceId) ?? 0;

            const isSpaceExpanded = prefs.spaceOpen[w.workspaceId] ?? blocked;
            const wsTabGroups = isSpaceExpanded || w.paneCount > 0
              ? groupPanesByTab(w.workspaceId, tabs, agents, shellPanes)
              : [];

            return (
              <div
                key={w.workspaceId}
                className={cn(
                  "flex flex-col transition-colors",
                  !blocked && "hover:bg-muted/30",
                  family && rowIndex > 0 && "border-t border-border/40",
                )}
              >
                {/* Level 1: Space Row */}
                <div
                  className={cn(
                    "flex flex-row gap-1 px-1.5 py-2",
                    branchLine ? "items-start" : "items-center",
                    blocked && "rounded-lg border border-status-blocked/40 bg-status-blocked/5",
                  )}
                >
                  {connector ? (
                    <WorktreeConnector glyph={connector} tallRow={!!branchLine} />
                  ) : null}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSpaceOpen(w.workspaceId, !isSpaceExpanded);
                    }}
                    aria-label={isSpaceExpanded ? `Collapse space ${rowLabel}` : `Expand space ${rowLabel}`}
                    className="flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
                  >
                    {isSpaceExpanded ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                  </button>

                  <TreeRowButton
                    onClick={() => handleSpaceRowClick(w, wsTabGroups, isSpaceExpanded)}
                    onMenu={actionsEnabled ? (at) => { setSheetAnchor(at); setSheetSpace(w); } : undefined}
                    className="py-0.5"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex min-w-0 items-center gap-2.5">
                        {status ? (
                          <>
                            <StatusDot status={status} />
                            <span className="sr-only">{STATUS_LABEL[status]}</span>
                          </>
                        ) : (
                          <span className="size-2.5 shrink-0 rounded-full border border-muted-foreground/40" />
                        )}
                        <span className="min-w-0 flex-1 truncate font-medium">{rowLabel}</span>
                        <span
                          aria-label={`${w.paneCount} ${w.paneCount === 1 ? "pane" : "panes"}`}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
                        >
                          <LayoutGrid className="size-3.5" aria-hidden />
                          {w.paneCount}
                        </span>
                        {seen > 0 && (
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {timeAgo(seen)}
                          </span>
                        )}
                      </div>
                      {branchLine ? (
                        <div className="flex min-w-0 items-center gap-1.5 pl-5 text-xs text-muted-foreground">
                          <GitBranch className="size-3 shrink-0 opacity-70" aria-hidden />
                          <span className="truncate">{branchLine}</span>
                        </div>
                      ) : null}
                    </div>
                  </TreeRowButton>
                  {actionsEnabled && (
                    <RowMoreButton
                      label="Space actions"
                      onMore={(at) => {
                        setSheetAnchor(at);
                        setSheetSpace(w);
                      }}
                    />
                  )}
                </div>

                {/* Expanded space children */}
                {isSpaceExpanded && (
                  <div className="flex flex-col pb-1.5 pl-6">
                    {wsTabGroups.map((group) => {
                      const tabPanes = group.panes;
                      const tabBucketKey = worstBucket(tabPanes);
                      const tabStatus = tabBucketKey ? TRIAGE_STATUS[tabBucketKey] : null;
                      const isMultiPane = tabPanes.length >= 2;
                      const isEmptyTab = tabPanes.length === 0;

                      const isTabExpanded = isMultiPane && prefs.expandedTabs.includes(group.tabId);
                      const tabRecord = tabs.find((t) => t.tabId === group.tabId);

                      return (
                        <div key={group.tabId} className="flex flex-col">
                          {/* Level 2: Tab Row */}
                          <div className="flex flex-row items-center gap-1 py-1.5 pr-1.5">
                            {isMultiPane ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setTabOpen(group.tabId, !isTabExpanded);
                                }}
                                aria-label={isTabExpanded ? `Collapse tab ${group.label}` : `Expand tab ${group.label}`}
                                className="flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
                              >
                                {isTabExpanded ? (
                                  <ChevronDown className="size-3.5" />
                                ) : (
                                  <ChevronRight className="size-3.5" />
                                )}
                              </button>
                            ) : (
                              <span className="size-11 shrink-0" />
                            )}

                            <TreeRowButton
                              disabled={isEmptyTab}
                              onClick={() => handleTabRowClick(group.tabId, tabPanes, isTabExpanded)}
                              onMenu={
                                actionsEnabled && tabRecord ? (at) => { setSheetAnchor(at); setSheetTab(tabRecord); } : undefined
                              }
                            >
                              {tabStatus ? (
                                <>
                                  <StatusDot status={tabStatus} />
                                  <span className="sr-only">{STATUS_LABEL[tabStatus]}</span>
                                </>
                              ) : (
                                <span className="size-2 shrink-0 rounded-full border border-muted-foreground/40" />
                              )}
                              <span className="min-w-0 flex-1 truncate text-sm font-normal text-foreground">
                                {group.label}
                              </span>
                              {isEmptyTab && (
                                <span className="text-xs text-muted-foreground italic">
                                  (empty tab)
                                </span>
                              )}
                              {isMultiPane && (
                                <span className="text-xs tabular-nums text-muted-foreground">
                                  {tabPanes.length} panes
                                </span>
                              )}
                            </TreeRowButton>
                            {actionsEnabled && tabRecord && (
                              <RowMoreButton
                                label="Tab actions"
                                onMore={(at) => {
                                  setSheetAnchor(at);
                                  setSheetTab(tabRecord);
                                }}
                              />
                            )}
                          </div>

                          {/* Level 3: Pane Rows (when multi-pane tab is expanded) */}
                          {isMultiPane && isTabExpanded && (
                            <div className="flex flex-col pl-7 pb-1">
                              {tabPanes.map((p) => {
                                const pStatus = shownStatus(p);
                                return (
                                  <div
                                    key={p.paneId}
                                    className={cn("flex flex-row items-center gap-1 py-1 pr-1.5", currentPaneId === p.paneId && "rounded bg-accent")}
                                  >
                                    <TreeRowButton
                                      onClick={() => navigate(panePath(p.paneId))}
                                      onMenu={
                                        actionsEnabled ? (at) => { setSheetAnchor(at); setSheetPane(p); } : undefined
                                      }
                                    >
                                      {p.kind === "shell" ? (
                                        p.paneLabel ? (
                                          <Plug className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                                        ) : (
                                          <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                                        )
                                      ) : (
                                        <>
                                          <StatusDot status={pStatus} runningCommand={p.runningCommand} />
                                          <span className="sr-only">{STATUS_LABEL[pStatus]}</span>
                                        </>
                                      )}
                                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground hover:text-foreground">
                                        {paneRowLabel(p, tabPanes)}
                                      </span>
                                      {p.lastSeenAt ? (
                                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                          {timeAgo(p.lastSeenAt)}
                                        </span>
                                      ) : null}
                                    </TreeRowButton>
                                    {actionsEnabled && (
                                      <RowMoreButton
                                        label="Pane actions"
                                        onMore={(at) => {
                                          setSheetAnchor(at);
                                          setSheetPane(p);
                                        }}
                                      />
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* New tab button */}
                    <div className="pt-2 pl-6">
                      <button
                        type="button"
                        onClick={() => onNewTab(w.workspaceId)}
                        aria-label="New tab"
                        className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent active:scale-95"
                      >
                        <Plus className="size-3.5" />
                        <span>New tab</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
                })}
                {cluster.closed.map((closed, closedIndex) => {
                  const sourceId = cluster.parent?.workspaceId ?? cluster.children[0]?.workspaceId;
                  const isLastClosed = closedIndex === cluster.closed.length - 1;
                  const connector: WorktreeConnectorGlyph | null = family
                    ? isLastClosed
                      ? "end"
                      : "fork"
                    : null;
                  const closedLabel = closed.branch ?? (closed.isDetached ? "detached" : closed.label);
                  return (
                    <div
                      key={closed.path}
                      className={cn(
                        "flex flex-row items-center gap-1 border-t border-border/40 px-1.5 py-2",
                        family && "hover:bg-muted/20",
                      )}
                    >
                      {connector ? <WorktreeConnector glyph={connector} /> : null}
                      <span className="size-11 shrink-0" />
                      <TreeRowButton
                        onClick={() => { if (!readOnly) void openClosed(sourceId, closed); }}
                      >
                        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                          {closedLabel}
                        </span>
                        <span className="shrink-0 rounded-full border border-dashed border-muted-foreground/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          closed
                        </span>
                      </TreeRowButton>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      {actionsEnabled && (
        <>
          <SpaceActionsSheet
            open={sheetSpace !== null}
            onClose={() => { setSheetSpace(null); setSheetAnchor(null); }}
            workspace={sheetSpace}
            linkedChildCount={
              sheetSpace
                ? (clusters.find((c) => c.parent?.workspaceId === sheetSpace.workspaceId)?.children.length ?? 0)
                : 0
            }
             anchor={sheetAnchor}
            readOnly={readOnly}
            onRenamed={onRenamed}
            onClosed={(workspaceId) => {
              const pane = currentPaneId
                ? [...agents, ...shellPanes].find((p) => p.paneId === currentPaneId)
                : undefined;
              if (pane?.workspaceId === workspaceId) navigate(homePath());
              onRenamed?.();
            }}
          />
          <TabActionsSheet
            open={sheetTab !== null}
            onClose={() => { setSheetTab(null); setSheetAnchor(null); }}
            tab={sheetTab}
             anchor={sheetAnchor}
            readOnly={readOnly}
            onRenamed={onRenamed}
            onClosed={(tabId) => {
              setTabOpen(tabId, false);
              onRenamed();
            }}
          />
          <PaneActionsSheet
            open={sheetPane !== null}
            onClose={() => { setSheetPane(null); setSheetAnchor(null); }}
            pane={sheetPane}
             anchor={sheetAnchor}
            readOnly={readOnly}
            onRenamed={onRenamed}
            onClosed={() => {
              onRenamed();
            }}
          />
        </>
      )}
    </section>
  );
}
