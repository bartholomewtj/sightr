import { ChevronDown, ChevronRight, File, Folder, GitBranch } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useNavigate } from "react-router";
import { fetchFiles, searchFiles } from "@/lib/api";
import { filePath } from "@/lib/nav";
import { contextMenuProps, type MenuPoint } from "@/lib/menu-anchor";
import { FileActionsSheet } from "@/components/file-actions-sheet";
import { useFilesTree, open, openAncestors, isDeletedFile, subscribeDeleted } from "@/lib/files-tree";
import type { FileEntry, FilesResponse, FileSearchResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useDesktop } from "@/lib/desktop";
import { FILES_TREE_ID } from "@/components/desktop-sidebar-slot";

function FileRowButton({ onClick, onMenu, children, className, ...props }: { onClick: () => void; onMenu?: (at: MenuPoint) => void; children: ReactNode; className?: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children" | "className">) {
  return <button type="button" onClick={onClick} {...contextMenuProps(onMenu)} {...props} className={cn("select-none [-webkit-touch-callout:none]", className)}>{children}</button>;
}

export function useFileSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileSearchResponse | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (query.trim().length < 2) { setResults(null); return; }
    const controller = new AbortController(); abort.current?.abort(); abort.current = controller;
    const timer = setTimeout(() => searchFiles(query, controller.signal).then(setResults).catch(() => {}), 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  return { query, setQuery, results, clear: () => { setQuery(""); setResults(null); } };
}

export function FileSearchResults({ results, onPick }: { results: FileSearchResponse; onPick?: () => void }) {
  const navigate = useNavigate(); const [folder, setFolder] = useState<string | null>(null); const [anchor, setAnchor] = useState<MenuPoint | null>(null); const [, setTick] = useState(0);
  useEffect(() => subscribeDeleted(() => setTick((n) => n + 1)), []);
  return <><div className="flex-1 overflow-auto px-3">{results.truncated && <p className="p-2 text-xs text-muted-foreground">Showing first 200 matches</p>}{results.results.filter((r) => !isDeletedFile(r.path)).map((r) => <FileRowButton className="flex w-full items-center gap-3 border-b p-3 text-left" key={r.path} onMenu={r.kind === "dir" ? (at) => { setFolder(r.path); setAnchor(at); } : undefined} onClick={() => { onPick?.(); openAncestors(r.path); if (r.kind === "dir") open(r.path); navigate(filePath(r.path)); }}>{r.kind === "dir" ? <Folder /> : <File />}<span className="flex-1">{r.name}</span>{r.kind === "dir" && <ChevronRight className="size-4" />}</FileRowButton>)}</div><FileActionsSheet open={folder !== null} path={folder} anchor={anchor} onClose={() => setFolder(null)} /></>;
}

interface FilesTreeProps { root?: Extract<FilesResponse, { kind: "dir" }>; selected?: string; onFolderSelect?: (path: string) => void; }
interface TreeRow { entry?: FileEntry; path: string; depth: number; open: boolean; truncated?: boolean; }

export function FilesTree({ root, selected = "", onFolderSelect }: FilesTreeProps) {
  const navigate = useNavigate(); const desktop = useDesktop().on; const tree = useFilesTree();
  const [listings, setListings] = useState<Record<string, Extract<FilesResponse, { kind: "dir" }>>>(() => root ? { "": root } : {} as Record<string, Extract<FilesResponse, { kind: "dir" }>>);
  const [activePath, setActivePath] = useState<string | undefined>(selected || undefined);
  const inFlight = useRef(new Set<string>());
  useEffect(() => { if (root) setListings((p) => p[""] ? p : { "": root }); }, [root]);
  useEffect(() => { if (selected) openAncestors(selected); }, [selected]);
  useEffect(() => subscribeDeleted((deleted) => { const name = deleted.split("/").pop()!; const parent = deleted.split("/").slice(0, -1).join("/"); setListings((p) => { const listing = p[parent]; return listing ? { ...p, [parent]: { ...listing, entries: listing.entries.filter((e) => e.name !== name) } } : p; }); }), []);
  const pathsToFetch = ["", ...tree.expanded].filter((path) => !listings[path] && !inFlight.current.has(path));
  useEffect(() => { const controller = new AbortController(); for (const path of pathsToFetch) { inFlight.current.add(path); fetchFiles(path, controller.signal).then((r) => { if (r.kind === "dir") setListings((p) => ({ ...p, [path]: { ...r, entries: r.entries.filter((e) => !isDeletedFile(path ? `${path}/${e.name}` : e.name)) } })); }).catch(() => {}).finally(() => inFlight.current.delete(path)); } return () => controller.abort(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.expanded.join("\u0000"), root]);

  const rows: TreeRow[] = [];
  const walk = (path: string, depth: number) => {
    const listing = listings[path]; if (!listing) return;
    for (const entry of listing.entries) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.kind === "file" && isDeletedFile(child)) continue;
      const isOpen = entry.kind === "dir" && tree.isOpen(child);
      rows.push({ entry, path: child, depth, open: isOpen });
      if (isOpen) walk(child, depth + 1);
    }
    if (listing.truncated) rows.push({ path: `${path}:truncated`, depth, open: false, truncated: true });
  };
  walk("", 0);
  useEffect(() => {
    if (selected) setActivePath(selected);
  }, [selected]);
  const [folder, setFolder] = useState<string | null>(null); const [anchor, setAnchor] = useState<MenuPoint | null>(null);
  const active = rows.findIndex((row) => row.path === activePath && row.entry);
  const focusRow = (index: number) => {
    const row = rows[index];
    if (!row?.entry) return;
    setActivePath(row.path);
    requestAnimationFrame(() => document.getElementById(`files-row-${index}`)?.scrollIntoView({ block: "nearest" }));
  };
  const openRow = (row: TreeRow) => {
    if (!row.entry) return;
    if (row.entry.kind === "dir") tree.open(row.path);
    navigate(filePath(row.path));
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!desktop || event.target instanceof HTMLInputElement || event.target instanceof HTMLPreElement || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const row = active >= 0 ? rows[active] : undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = active < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1) : active + (event.key === "ArrowDown" ? 1 : -1);
      focusRow(Math.max(0, Math.min(rows.length - 1, next))); return;
    }
    if (!row?.entry) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.entry.kind === "dir" && row.open) tree.toggle(row.path);
      else { const parent = row.path.split("/").slice(0, -1).join("/"); const index = rows.findIndex((item) => item.path === parent && item.entry); if (index >= 0) focusRow(index); }
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (row.entry.kind === "dir" && !row.open) tree.toggle(row.path);
      else if (row.entry.kind === "dir") { const index = rows.findIndex((item, i) => i > active && item.depth > row.depth && item.entry); if (index >= 0) focusRow(index); }
      return;
    }
    if (event.key === "Enter") { event.preventDefault(); openRow(row); }
  };
  return <div id={FILES_TREE_ID} role="tree" tabIndex={desktop ? 0 : undefined} aria-activedescendant={desktop && active >= 0 ? `files-row-${active}` : undefined} onKeyDown={onKeyDown} className="overflow-auto">
    {rows.map((row, index) => { const { entry, path, depth, open: isOpen } = row; if (!entry) return <div key={path} className="px-2 py-2 text-xs text-muted-foreground" style={{ paddingLeft: (depth + 1) * 16 + 8 }}>listing truncated</div>; const icon = entry.kind === "dir" ? <Folder className="size-4 shrink-0" /> : <File className="size-4 shrink-0" />; return desktop ? <div id={`files-row-${index}`} key={path} role="treeitem" aria-expanded={entry.kind === "dir" ? isOpen : undefined} aria-current={entry.kind === "file" && selected === path ? "page" : undefined} className={cn("flex items-center gap-1 border-b", selected === path && "bg-muted", activePath === path && "bg-accent")} style={{ paddingLeft: depth * 16 + 8, paddingRight: 8 }}>{entry.kind === "dir" ? <button type="button" aria-label={`${isOpen ? "Collapse" : "Expand"} ${entry.name}`} className="shrink-0 p-1" onClick={() => tree.toggle(path)}>{isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</button> : <span className="size-6 shrink-0" />}<FileRowButton onMenu={entry.kind === "dir" ? (at) => { setFolder(path); setAnchor(at); } : undefined} className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left" onClick={() => { if (entry.kind === "dir") tree.open(path); navigate(filePath(path)); }}>{icon}<span className="truncate">{entry.name}</span>{entry.repo && <GitBranch aria-label="git checkout" className="size-3 shrink-0 text-muted-foreground" />}</FileRowButton></div> : <FileRowButton key={path} role="treeitem" onMenu={entry.kind === "dir" ? (at) => { setFolder(path); setAnchor(at); } : undefined} aria-expanded={entry.kind === "dir" ? isOpen : undefined} aria-current={entry.kind === "file" && selected === path ? "page" : undefined} className={cn("flex w-full items-center gap-2 border-b py-2 text-left", selected === path && "bg-muted")} style={{ paddingLeft: depth * 16 + 8, paddingRight: 8 }} onClick={() => { if (entry.kind !== "dir") { navigate(filePath(path)); return; } const opening = !tree.isOpen(path); tree.toggle(path); onFolderSelect?.(opening ? path : path.split("/").slice(0, -1).join("/")); }}>{entry.kind === "dir" ? (isOpen ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />) : <span className="size-4 shrink-0" />}{icon}<span className="min-w-0 truncate">{entry.name}</span>{entry.repo && <GitBranch aria-label="git checkout" className="size-3 shrink-0 text-muted-foreground" />}</FileRowButton>; })}
    {listings[""] && rows.length === 0 && <div className="p-3 text-sm text-muted-foreground">Nothing here</div>}
    <FileActionsSheet open={folder !== null} path={folder} anchor={anchor} onClose={() => setFolder(null)} />
  </div>;
}
export type { FileEntry };
