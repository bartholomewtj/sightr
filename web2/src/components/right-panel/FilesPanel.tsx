/**
 * The Files tab (T13): v1's Files endpoints and rules, started at the thread's folder. A tree (folders
 * expand in place; the expanded set is v1's per-device `files-tree`) with search on top; a file opens
 * in a detail view inside the tab (text preview, image/video/audio, download, "Open in browser" through
 * the sandboxed open URL, ADR 0027). Edit and delete follow v1's `routes/files.tsx`: leaving dirty
 * edits asks first, delete needs a second tap, a read-only device gets neither. The client only joins
 * names; containment is the bridge's (ADR 0026). "Servers on this PC" (v1's Local tab) sits below.
 *
 * Phone: the sheet is not kept mounted, so the folder, the open file and each scroll position are
 * remembered per thread (module state, this page's life) and come back when the sheet reopens. Names
 * and paths wrap instead of truncating (the end of a path is the part that matters), rows and links
 * grow to a thumb-sized target on a touch screen, fields stay 16 px (iOS zooms the page below that),
 * and the file's action row sticks to the top of the scroller so Save is in reach while editing.
 */
import { ArrowLeftIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon, DownloadIcon, ExternalLinkIcon, FileIcon, FolderIcon, GitBranchIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { FileEntry, FileSearchResponse, FilesResponse } from "@shared/wire";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import ChatMarkdown from "@/components/ChatMarkdown";
import { showToast } from "@/components/toast";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useScrollMemory } from "@/hooks/use-scroll-memory";
import { deleteFile, downloadFileUrl, fetchFiles, fetchLocalServers, openFileUrl, saveFile, searchFiles, type LocalServersResponse } from "@/lib/api";
import { isDeletedFile, noteDeletedFile, subscribeDeleted, useFilesTree } from "@/lib/files-tree";
import { useRightPanelStore } from "@/rightPanelStore";
import { useSidebarThread } from "@/state/sidebar";
import { useBridgeInfo, useThread } from "@/stream/stores";

import { setPanelLeaveGuard } from "./leaveGuard";
import { usePaneFolder } from "./usePaneFolder";

type DirListing = Extract<FilesResponse, { kind: "dir" }>;
type FileData = Extract<FilesResponse, { kind: "file" }>;

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const baseName = (path: string) => path.split("/").pop() ?? path;

/** Where each thread's Files tab was left (folder and open file), so a reopened sheet resumes there. */
const navMemory = new Map<string, { base: string | null; openPath: string | null }>();

/** Test helper. */
export function __resetFilesNav(): void {
  navMemory.clear();
}

export function FilesPanel({ threadId }: { threadId: string }) {
  const state = useThread(threadId);
  const shellThread = useSidebarThread(threadId);
  const thread = state?.thread ?? shellThread ?? null;
  const folder = usePaneFolder(thread?.paneId || null);
  const readOnly = useBridgeInfo((s) => s.readOnly);
  const [base, setBase] = useState<string | null>(() => navMemory.get(threadId)?.base ?? null);
  const [openPath, setOpenPath] = useState<string | null>(() => navMemory.get(threadId)?.openPath ?? null);
  const leaveGuard = useRef<((go: () => void) => boolean) | null>(null);
  // A restored folder outranks the thread's folder the first time it resolves; later changes still move the tab.
  const restored = useRef(base !== null);
  useEffect(() => {
    navMemory.set(threadId, { base, openPath });
  }, [threadId, base, openPath]);

  // Switching tabs or closing the panel asks the open editor first.
  useEffect(() => {
    setPanelLeaveGuard((go) => leaveGuard.current?.(go) ?? false);
    return () => setPanelLeaveGuard(null);
  }, []);

  // The tab starts at the thread's folder, or the Files root when that is outside it.
  useEffect(() => {
    if (folder.path === undefined) return;
    if (restored.current) {
      restored.current = false;
      return;
    }
    setBase(folder.path ?? "");
  }, [folder.path]);

  /** Run `go` now, or once the operator chose to drop dirty edits. */
  const leave = (go: () => void) => {
    if (leaveGuard.current?.(go)) return;
    go();
  };

  // "Open in Files" from anywhere (rightPanelStore.openFile): a file opens in the detail view, a folder
  // becomes the tree's base. Taken once, for this thread; unsaved edits are asked about first.
  const fileRequest = useRightPanelStore((s) => (s.fileRequest?.threadId === threadId ? s.fileRequest : null));
  const consumeFileRequest = useRightPanelStore((s) => s.consumeFileRequest);
  useEffect(() => {
    if (!fileRequest) return;
    consumeFileRequest(fileRequest.id);
    leave(() => {
      if (fileRequest.kind === "dir") {
        // Before the thread's folder resolves, keep it from replacing the requested folder.
        if (folder.path === undefined) restored.current = true;
        setBase(fileRequest.path);
        setOpenPath(null);
      } else setOpenPath(fileRequest.path);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one request, taken once
  }, [fileRequest?.id]);

  if (!thread) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (folder.filesOff) return <p className="p-4 text-sm text-muted-foreground">Files isn't turned on. Set SIGHTR_WORK_ROOT on the host.</p>;
  if (base === null) return <p className="p-4 text-sm text-muted-foreground">Finding the thread's folder…</p>;

  if (openPath !== null) {
    return (
      <FileDetail
        key={openPath}
        scrollKey={`files:${threadId}:file`}
        path={openPath}
        readOnly={readOnly}
        guard={leaveGuard}
        onBack={() => leave(() => setOpenPath(null))}
        onDeleted={() => setOpenPath(null)}
      />
    );
  }
  return (
    <FilesBrowser
      scrollKey={`files:${threadId}:browse`}
      base={base}
      outsideNote={folder.path === null}
      onUp={() => setBase(parentOf(base))}
      onOpenFolder={(path) => setBase(path)}
      onOpenFile={(path) => setOpenPath(path)}
    />
  );
}

// ── Browser: search, tree, servers ──────────────────────────────────────────────────────────────

/** v1 `useFileSearch`: debounced, superseded queries aborted, a timeout reads as one. */
function useFileSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileSearchResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (query.trim().length < 2) {
      setResults(null);
      setPending(false);
      return;
    }
    const controller = new AbortController();
    setResults(null);
    setPending(true);
    const timer = setTimeout(
      () =>
        searchFiles(query, controller.signal)
          .then((r) => {
            setResults(r);
            setPending(false);
          })
          .catch((e: unknown) => {
            if (controller.signal.aborted) return;
            setPending(false);
            setError(e instanceof Error && /time|abort/i.test(`${e.name} ${e.message}`) ? "Search took too long. Try a longer name." : "Search failed.");
          }),
      200,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return { query, setQuery, results, pending, error };
}

function FilesBrowser(props: {
  scrollKey: string;
  base: string;
  outsideNote: boolean;
  onUp: () => void;
  onOpenFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const search = useFileSearch();
  const scrollRef = useScrollMemory<HTMLDivElement>(`${props.scrollKey}:${props.base}`);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-files-tab="">
      <div className="border-b p-2">
        <input
          type="search"
          aria-label="Find files"
          placeholder="Find files"
          value={search.query}
          onChange={(e) => search.setQuery(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="search"
          className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-base text-foreground outline-none placeholder:text-placeholder sm:h-8 sm:text-sm"
        />
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        {search.query.trim().length >= 2 ? (
          <SearchResults search={search} onOpenFolder={props.onOpenFolder} onOpenFile={props.onOpenFile} />
        ) : (
          <>
            <div className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
              <Button size="icon-xs" variant="ghost-muted" aria-label="Up one folder" disabled={props.base === ""} onClick={props.onUp}>
                <ArrowUpIcon />
              </Button>
              <span className="min-w-0 flex-1 wrap-anywhere font-mono" data-files-base={props.base}>
                {props.base === "" ? "Files root" : props.base}
              </span>
            </div>
            {props.outsideNote ? (
              <p className="px-3 pb-2 text-xs text-muted-foreground">This thread's folder is outside the Files root; showing the root.</p>
            ) : null}
            <FilesTree base={props.base} onOpenFile={props.onOpenFile} />
          </>
        )}
        <LocalServers />
      </div>
    </div>
  );
}

function SearchResults({
  search,
  onOpenFolder,
  onOpenFile,
}: {
  search: ReturnType<typeof useFileSearch>;
  onOpenFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const status = search.error ?? (search.pending ? "Searching…" : search.results && search.results.results.length === 0 ? "No matches" : null);
  return (
    <div aria-label="Search results">
      {status ? (
        <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
          {status}
        </p>
      ) : null}
      {search.results?.truncated ? <p className="px-3 py-1 text-xs text-muted-foreground">The search stopped early. Try a longer name.</p> : null}
      {search.results?.results
        .filter((r) => !isDeletedFile(r.path))
        .map((r) => (
          <button
            key={r.path}
            type="button"
            className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-sm hover:bg-accent pointer-coarse:py-2.5"
            onClick={() => (r.kind === "dir" ? (search.setQuery(""), onOpenFolder(r.path)) : onOpenFile(r.path))}
          >
            {r.kind === "dir" ? <FolderIcon className="size-4 shrink-0" /> : <FileIcon className="size-4 shrink-0" />}
            <span className="min-w-0 flex-1">
              <span className="block wrap-anywhere">{r.name}</span>
              {r.path.includes("/") ? <span className="block wrap-anywhere text-xs text-muted-foreground">{parentOf(r.path)}</span> : null}
            </span>
          </button>
        ))}
    </div>
  );
}

interface TreeRow {
  entry?: FileEntry;
  path: string;
  depth: number;
  open: boolean;
}

/** v1's `FilesTree` rows, rooted at `base` (folders expand in place, listings fetched as they open). */
function FilesTree({ base, onOpenFile }: { base: string; onOpenFile: (path: string) => void }) {
  const tree = useFilesTree();
  const [listings, setListings] = useState<Record<string, DirListing>>({});
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(new Set<string>());
  // One controller per base: reads are aborted when the base changes or the tree unmounts, never
  // because another folder was opened meanwhile.
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const mine = new AbortController();
    controller.current = mine;
    setListings({});
    setFailed(false);
    inFlight.current.clear();
    return () => mine.abort();
  }, [base]);
  useEffect(
    () =>
      subscribeDeleted((deleted) => {
        const name = baseName(deleted);
        const parent = parentOf(deleted);
        setListings((p) => {
          const listing = p[parent];
          return listing ? { ...p, [parent]: { ...listing, entries: listing.entries.filter((e) => e.name !== name) } } : p;
        });
      }),
    [],
  );

  const wanted = [base, ...tree.expanded.filter((p) => base === "" || p.startsWith(`${base}/`))];
  const toFetch = wanted.filter((p) => !listings[p] && !inFlight.current.has(p));
  useEffect(() => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    for (const path of toFetch) {
      inFlight.current.add(path);
      fetchFiles(path, signal)
        .then((r) => {
          if (!signal.aborted && r.kind === "dir") setListings((p) => ({ ...p, [path]: r }));
        })
        .catch(() => {
          if (!signal.aborted && path === base) setFailed(true);
        })
        .finally(() => inFlight.current.delete(path));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the joined list is the dependency
  }, [toFetch.join("\u0000"), base]);

  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    const listing = listings[dir];
    if (!listing) return;
    for (const entry of listing.entries) {
      const child = join(dir, entry.name);
      if (entry.kind === "file" && isDeletedFile(child)) continue;
      const isOpen = entry.kind === "dir" && tree.isOpen(child);
      rows.push({ entry, path: child, depth, open: isOpen });
      if (isOpen) walk(child, depth + 1);
    }
  };
  walk(base, 0);

  if (failed) return <p className="px-3 py-2 text-sm text-muted-foreground">Couldn't list this folder.</p>;
  if (!listings[base]) return <p className="px-3 py-2 text-sm text-muted-foreground">Listing…</p>;
  return (
    <div role="tree" aria-label="Files">
      {rows.length === 0 ? <p className="px-3 py-2 text-sm text-muted-foreground">Nothing here</p> : null}
      {rows.map(({ entry, path, depth, open }) =>
        entry ? (
          <button
            key={path}
            type="button"
            role="treeitem"
            aria-expanded={entry.kind === "dir" ? open : undefined}
            data-file-row={path}
            className="flex w-full items-center gap-1.5 border-b py-1.5 pe-2 text-left text-sm hover:bg-accent pointer-coarse:py-2.5"
            style={{ paddingLeft: depth * 14 + 8 }}
            onClick={() => (entry.kind === "dir" ? tree.toggle(path) : onOpenFile(path))}
          >
            {entry.kind === "dir" ? (
              open ? (
                <ChevronDownIcon className="size-3.5 shrink-0" />
              ) : (
                <ChevronRightIcon className="size-3.5 shrink-0" />
              )
            ) : (
              <span className="size-3.5 shrink-0" />
            )}
            {entry.kind === "dir" ? <FolderIcon className="size-4 shrink-0" /> : <FileIcon className="size-4 shrink-0" />}
            <span className="min-w-0 wrap-anywhere">{entry.name}</span>
            {entry.repo ? <GitBranchIcon aria-label="git checkout" className="size-3 shrink-0 text-muted-foreground" /> : null}
          </button>
        ) : null,
      )}
      {listings[base]?.truncated ? <p className="px-3 py-1 text-xs text-muted-foreground">listing truncated</p> : null}
    </div>
  );
}

/** v1's Local tab as a section: loopback listeners on the PC, opened over the tailnet. */
function LocalServers() {
  const [data, setData] = useState<LocalServersResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetchLocalServers(controller.signal)
      .then(setData)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);
  return (
    <section aria-label="Servers on this PC" className="border-t">
      <h3 className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">Servers on this PC</h3>
      {failed ? <p className="px-3 pb-2 text-sm text-muted-foreground">Couldn't list them.</p> : null}
      {data && !data.host ? <p className="px-3 pb-2 text-sm text-muted-foreground">Tailscale isn't running on this PC.</p> : null}
      {data?.host && data.servers.length === 0 ? <p className="px-3 pb-2 text-sm text-muted-foreground">Nothing is listening on localhost.</p> : null}
      {data?.host
        ? data.servers.map((server) => (
            <a
              key={server.port}
              href={`http://${data.host}:${server.port}/`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 border-b px-3 py-1.5 text-sm hover:bg-accent pointer-coarse:py-2.5"
            >
              <span className="min-w-0 flex-1 wrap-anywhere">{server.name || `port ${server.port}`}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">:{server.port}</span>
            </a>
          ))
        : null}
    </section>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────────────────────────

function FileDetail(props: {
  scrollKey: string;
  path: string;
  readOnly: boolean;
  guard: { current: ((go: () => void) => boolean) | null };
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [data, setData] = useState<FileData | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState<{ text: string; mtimeMs: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const { confirm, pending } = usePendingConfirm();
  const scrollRef = useScrollMemory<HTMLDivElement>(`${props.scrollKey}:${props.path}`);

  useEffect(() => {
    const controller = new AbortController();
    fetchFiles(props.path, controller.signal)
      .then((r) => {
        if (r.kind !== "file") {
          setFailed(true);
          return;
        }
        const lf = (r.text ?? "").replace(/\r\n/g, "\n");
        setData(r);
        setSaved({ text: lf, mtimeMs: r.mtimeMs });
        setDraft(lf);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [props.path]);

  const dirty = editing && saved !== null && draft !== saved.text;
  // Leaving with dirty edits asks first (v1's blocker); the page itself gets beforeunload.
  props.guard.current = (go) => {
    if (!dirty) return false;
    setPendingLeave(() => go);
    return true;
  };
  useEffect(
    () => () => {
      props.guard.current = null;
    },
    [props.guard],
  );
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  async function onSave() {
    if (saving || !dirty || !saved) return;
    setSaving(true);
    try {
      const res = await saveFile(props.path, draft, saved.mtimeMs);
      if (res.ok) {
        setSaved({ text: draft, mtimeMs: res.mtimeMs });
        setEditing(false);
        showToast("Saved");
      } else showToast(res.error === "file changed" ? "File changed on disk. Not saved." : (res.error ?? "Save failed"), "error");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (deleting || !confirm(`delete:${props.path}`)) return;
    setDeleting(true);
    try {
      const res = await deleteFile(props.path);
      if (res.ok) {
        noteDeletedFile(props.path);
        props.onDeleted();
      } else showToast(res.error ?? "Delete failed", "error");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setDeleting(false);
    }
  }

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(props.path);
      showToast("Path copied");
    } catch {
      showToast("Couldn't copy the path", "error");
    }
  };

  const src = openFileUrl(props.path);
  const editable = data !== null && data.binary === false && data.truncated !== true && !props.readOnly;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-file-detail={props.path}>
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <Button size="icon-xs" variant="ghost-muted" aria-label="Back to files" onClick={props.onBack}>
          <ArrowLeftIcon />
        </Button>
        <span className="min-w-0 flex-1 wrap-anywhere text-sm font-medium">{baseName(props.path)}</span>
      </div>
      {pendingLeave ? (
        <div role="alertdialog" aria-label="Unsaved edits" className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2 text-sm">
          <span className="flex-1">Unsaved edits</span>
          <Button size="xs" variant="outline" onClick={() => setPendingLeave(null)}>
            Stay
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            onClick={() => {
              const go = pendingLeave;
              setPendingLeave(null);
              setEditing(false);
              setDraft(saved?.text ?? "");
              props.guard.current = null;
              go();
            }}
          >
            Discard edits
          </Button>
        </div>
      ) : null}
      {failed ? <p className="p-3 text-sm text-muted-foreground">Not found.</p> : null}
      {data ? (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto overscroll-y-contain p-3">
          <div className="sticky -top-3 z-10 -mx-3 -mt-3 mb-3 flex flex-wrap gap-1.5 bg-background px-3 pt-3 pb-2">
            {data.openInBrowser ? (
              <a
                className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-medium pointer-coarse:min-h-11"
                href={src}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLinkIcon className="size-4" />
                Open in browser
              </a>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => void copyPath()}>
              <CopyIcon />
              Copy path
            </Button>
            <a
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-medium pointer-coarse:min-h-11"
              href={downloadFileUrl(props.path)}
              download={data.name}
            >
              <DownloadIcon className="size-4" />
              Download
            </a>
            {editing ? (
              <>
                <Button size="sm" disabled={!dirty || saving} onClick={() => void onSave()}>
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    setDraft(saved?.text ?? "");
                    setEditing(false);
                  }}
                >
                  Discard
                </Button>
              </>
            ) : editable ? (
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
            {data.binary === false && !props.readOnly && !editing ? (
              <Button
                size="sm"
                variant={pending === `delete:${props.path}` ? "destructive" : "destructive-outline"}
                disabled={deleting}
                onClick={() => void onDelete()}
              >
                <Trash2Icon />
                {deleting ? "Deleting…" : pending === `delete:${props.path}` ? `Really delete ${data.name}?` : "Delete"}
              </Button>
            ) : null}
          </div>
          {editing ? (
            <textarea
              aria-label={`Edit ${data.name}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void onSave();
                }
              }}
              className="min-h-[40dvh] w-full resize-y whitespace-pre-wrap break-words rounded border bg-background p-2 font-mono text-base sm:text-sm"
            />
          ) : (
            <FilePreview data={data} text={saved?.text ?? ""} src={src} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function FilePreview({ data, text, src }: { data: FileData; text: string; src: string }) {
  if (data.embed === "image") return <img src={src} alt={data.name} className="max-h-[70dvh] max-w-full object-contain" />;
  if (data.embed === "video") return <video src={src} controls playsInline preload="metadata" className="max-h-[70dvh] w-full bg-black" />;
  if (data.embed === "audio") return <audio src={src} controls preload="metadata" className="w-full" />;
  if (data.binary)
    return (
      <p className="text-sm text-muted-foreground">
        {data.openInBrowser ? "Can't preview this file here. Open it in the browser or download it." : "Can't preview this file. Download it instead."}
      </p>
    );
  const note = data.truncated ? <p className="text-xs text-muted-foreground">truncated at 512 KB</p> : null;
  if (/\.(md|markdown)$/i.test(data.name))
    return (
      <>
        <ChatMarkdown text={text} />
        {note}
      </>
    );
  return (
    <>
      <pre className={cn("whitespace-pre-wrap break-words font-mono text-sm")} data-file-text="">
        {text}
      </pre>
      {note}
    </>
  );
}
