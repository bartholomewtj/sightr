import { useEffect, useState } from "react";
import { Activity, Folder, LayoutGrid, Settings } from "lucide-react";
import { useLocation, useNavigate, useRevalidator } from "react-router";
import { cn } from "@/lib/utils";
import { SpaceTree } from "@/components/space-tree";
import { SightrHome } from "@/components/sightr-home";
import { homePath, tracesPath, filesPath, settingsPath } from "@/lib/nav";
import type { HomeData } from "@/lib/loaders";
import { isReadOnly } from "@/lib/types";
import { isConnecting } from "@/lib/connection";
import { useConnectionLost, useConnectionTrouble } from "@/hooks/use-connection-lost";
import { useSpaceActions } from "@/hooks/use-spaces";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { FilesTree, FileSearchResults, useFileSearch } from "@/components/files-tree";
import { sidebarSlot, filesRelFromPath, tracesRepoFromPath, FILES_FIND_ID, FILES_TREE_ID } from "@/components/desktop-sidebar-slot";
import { TracesList, liveTraceRepos, traceRows } from "@/routes/traces";
import { fetchFiles } from "@/lib/api";

export function DesktopSidebar({ data, currentPaneId }: { data: HomeData; currentPaneId?: string }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const { pathname, search } = useLocation();
  const connecting = isConnecting({ bridge: data.bridge, error: data.error });
  const trouble = useConnectionTrouble(connecting);
  const lost = useConnectionLost(connecting);
  const { newSpace, newTab } = useSpaceActions();
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [focusTreeRequested, setFocusTreeRequested] = useState(false);
  const fileSearch = useFileSearch();
  const [fileRoot, setFileRoot] = useState<Extract<import("@/lib/types").FilesResponse, { kind: "dir" }> | undefined>();
  const slot = sidebarSlot(pathname, search);
  const focusTree = () => document.getElementById(FILES_TREE_ID)?.focus();
  useEffect(() => {
    if (slot === "files" && focusTreeRequested && !fileSearch.results) {
      focusTree();
      setFocusTreeRequested(false);
    }
  }, [slot, focusTreeRequested, fileSearch.results]);
  useEffect(() => { if (slot === "files" && data.files) fetchFiles("").then((value) => { if (value.kind === "dir") setFileRoot(value); }).catch(() => {}); }, [slot, data.files]);
  const liveRepos = liveTraceRepos(data);
  const items = [
    { label: "Spaces", icon: LayoutGrid, to: homePath(), active: pathname === "/" },
    ...(data.workspaces.some((w) => w.sssf) ? [{ label: "Traces", live: liveRepos.length ? liveRepos.join(", ") : undefined, icon: Activity, to: tracesPath(), active: pathname.startsWith("/traces") }] : []),
    ...(data.files ? [{ label: "Files", icon: Folder, to: filesPath(), active: pathname.startsWith("/files") }] : []),
    { label: "Settings", icon: Settings, to: settingsPath(), active: pathname === "/settings" },
  ];
  // Ends are pinned; only the tree box scrolls (spec §2a).
  return <aside className="absolute inset-0 flex min-h-0 flex-col overflow-hidden border-r-2 border-border bg-muted">
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border p-3"><SightrHome trouble={trouble} lost={lost} wordmark /></div>
    <div className="min-h-0 flex-1 overflow-hidden">{slot === "files" && data.files ? <><div className="shrink-0 bg-muted p-3"><input id={FILES_FIND_ID} type="search" value={fileSearch.query} onChange={(e) => fileSearch.setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); fileSearch.clear(); setFocusTreeRequested(true); } }} placeholder="Find files" className="w-full rounded border bg-background px-3 py-2" /></div><div className="min-h-0 h-[calc(100%-76px)] overflow-y-auto">{fileSearch.results ? <FileSearchResults results={fileSearch.results} onPick={fileSearch.clear} /> : <FilesTree root={fileRoot} selected={filesRelFromPath(pathname)} />}</div></> : slot === "traces" ? <div className="h-full overflow-y-auto"><TracesList rows={traceRows(data)} selected={tracesRepoFromPath(pathname)} /></div> : <div className="h-full overflow-y-auto"><SpaceTree workspaces={data.workspaces} tabs={data.tabs} agents={data.agents} shellPanes={data.shellPanes} onNewSpace={() => setNewSpaceOpen(true)} onNewTab={newTab} onRenamed={() => revalidator.revalidate()} readOnly={isReadOnly(data.device)} currentPaneId={currentPaneId} error={data.error} lastSeenAt={data.lastSeenAt} /></div>}</div>
    <nav aria-label="Desktop navigation" className="mt-auto shrink-0 border-t-2 border-border p-2">{items.map((item) => <button key={item.label} type="button" aria-current={item.active ? "page" : undefined} aria-label={"live" in item && item.live ? `Traces, ${item.live} running` : undefined} onClick={() => navigate(item.to)} className={cn("flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm", item.active ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50")}><item.icon className="size-4 shrink-0" /><span className="flex min-w-0 flex-1 items-center justify-between gap-2"><span>{item.label}</span>{"live" in item && item.live ? <span className="flex min-w-0 items-center gap-1 text-status-running"><span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-status-running" /><span className="truncate">{item.live}</span></span> : null}</span></button>)}</nav>
    <NewSpaceSheet open={newSpaceOpen} onClose={() => setNewSpaceOpen(false)} onCreate={newSpace} />
  </aside>;
}
