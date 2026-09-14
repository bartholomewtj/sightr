import { useSyncExternalStore } from "react";

interface FilesTreeState { expanded: string[] }

const STORAGE_KEY = "sightr:files-tree:v1";
const DEFAULTS: FilesTreeState = { expanded: [] };
let state: FilesTreeState | undefined;
const listeners = new Set<() => void>();
const deletedPaths = new Set<string>();
const deletedListeners = new Set<(path: string) => void>();

export function noteDeletedFile(path: string): void { deletedPaths.add(path); deletedListeners.forEach((fn) => fn(path)); }
export function isDeletedFile(path: string): boolean { return deletedPaths.has(path); }
export function subscribeDeleted(fn: (path: string) => void): () => void { deletedListeners.add(fn); return () => deletedListeners.delete(fn); }

function load(): FilesTreeState {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<FilesTreeState>;
    const expanded = Array.isArray(parsed.expanded)
      ? [...new Set(parsed.expanded.filter((path): path is string => typeof path === "string" && path !== ""))]
      : [];
    return { expanded };
  } catch { return DEFAULTS; }
}
function current(): FilesTreeState { return (state ??= load()); }
function save(next: FilesTreeState): void {
  state = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* memory remains authoritative */ }
  listeners.forEach((fn) => fn());
}

export function filesTreeState(): FilesTreeState { return current(); }

export function isOpen(path: string): boolean {
  return path === "" || current().expanded.includes(path);
}

function update(expanded: string[]): void {
  save({ expanded: [...new Set(expanded.filter((path) => path !== ""))] });
}

export function toggle(path: string): void {
  if (path === "") return;
  const { expanded } = current();
  update(expanded.includes(path) ? expanded.filter((item) => item !== path) : [...expanded, path]);
}

export function open(path: string): void {
  if (path === "" || current().expanded.includes(path)) return;
  update([...current().expanded, path]);
}

export function openAncestors(path: string): void {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return;
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join("/"));
  }
  const expanded = current().expanded;
  const next = [...expanded, ...ancestors.filter((ancestor) => !expanded.includes(ancestor))];
  if (next.length !== expanded.length) update(next);
}

export interface FilesTree extends FilesTreeState {
  isOpen(path: string): boolean;
  toggle(path: string): void;
  open(path: string): void;
  openAncestors(path: string): void;
}

export function useFilesTree(): FilesTree {
  const snapshot = useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    filesTreeState,
    () => DEFAULTS,
  );
  return {
    ...snapshot,
    isOpen,
    toggle,
    open,
    openAncestors,
  };
}

export function __resetFilesTree(): void {
  state = undefined;
  deletedPaths.clear();
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  listeners.forEach((fn) => fn());
}
