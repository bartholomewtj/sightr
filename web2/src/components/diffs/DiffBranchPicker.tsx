// Sightr code (T27). The base branch for the "Branch vs {base}" scope: the names come from T26's branch list
// (`fetchDiffBranches`). On a desktop it is a submenu of the scope menu (a Base UI `ui/menu.tsx` dropdown); on
// a phone it is the second view of the scope sheet (44 px rows, and a filter box, since there can be 200
// names). "Default base" drops the choice, so the bridge picks (upstream, then origin/HEAD, main, master).
import type { ReviewBranches } from "@shared/v2/review";
import { CheckIcon, GitBranchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { fetchDiffBranches } from "@/lib/diffApi";
import { cn } from "~/lib/utils";

import { Input } from "../ui/input";
import { MenuItem, MenuRadioGroup, MenuRadioItem, MenuSub, MenuSubPopup, MenuSubTrigger } from "../ui/menu";
import { reviewReason } from "./diffReasons";
import { relativeTime } from "../right-panel/GitPanel.logic";

export type BranchesState =
  | { status: "idle" | "loading" | "error" }
  | { status: "unavailable"; reason: string }
  | { status: "ready"; data: Extract<ReviewBranches, { available: true }> };

/** The branch list for the thread's folder, read when `enabled` (the picker is open, or a stored base needs checking). */
export function useDiffBranches(folderPath: string | null | undefined, enabled: boolean, refreshToken = 0): BranchesState {
  const [state, setState] = useState<BranchesState>({ status: "idle" });
  useEffect(() => {
    if (!enabled || !folderPath) return;
    const controller = new AbortController();
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    fetchDiffBranches(folderPath, controller.signal).then(
      (r) => {
        if (controller.signal.aborted) return;
        setState(r.available ? { status: "ready", data: r } : { status: "unavailable", reason: r.reason });
      },
      () => {
        if (!controller.signal.aborted) setState((s) => (s.status === "ready" ? s : { status: "error" }));
      },
    );
    return () => controller.abort();
  }, [folderPath, enabled, refreshToken]);
  return state;
}

/** Whether `baseRef` is a branch the list knows. Unknown while the list has not been read. */
export function baseExists(state: BranchesState, baseRef: string): boolean | null {
  return state.status === "ready" ? state.data.branches.some((b) => b.name === baseRef) : null;
}

function describe(state: BranchesState): string | null {
  if (state.status === "ready") return state.data.branches.length === 0 ? "No branches." : null;
  if (state.status === "unavailable") return reviewReason(state.reason);
  return state.status === "error" ? "Couldn't read the branches." : "Loading branches…";
}

/** Desktop: the base as a submenu of the scope menu. */
export function DiffBranchMenu(props: { state: BranchesState; baseRef: string | undefined; defaultBase: string | undefined; onOpen: () => void; onPick: (baseRef: string | undefined) => void }) {
  const { state, baseRef, defaultBase, onOpen, onPick } = props;
  const note = describe(state);
  return (
    <MenuSub onOpenChange={(open) => open && onOpen()}>
      <MenuSubTrigger>
        <GitBranchIcon aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">Base: {baseRef ?? defaultBase ?? "default"}</span>
      </MenuSubTrigger>
      <MenuSubPopup className="max-h-80 min-w-56">
        <MenuRadioGroup value={baseRef ?? ""} onValueChange={(v) => onPick(v === "" ? undefined : String(v))}>
          <MenuRadioItem value="">Default base{defaultBase ? ` (${defaultBase})` : ""}</MenuRadioItem>
          {state.status === "ready"
            ? state.data.branches.map((b) => (
                <MenuRadioItem key={b.name} value={b.name}>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{b.name}</span>
                </MenuRadioItem>
              ))
            : null}
        </MenuRadioGroup>
        {note ? <MenuItem disabled>{note}</MenuItem> : null}
        {state.status === "ready" && state.data.truncated ? <MenuItem disabled>Newest 200 branches shown.</MenuItem> : null}
      </MenuSubPopup>
    </MenuSub>
  );
}

/** Phone: the branch view of the scope sheet. */
export function DiffBranchSheetView(props: { state: BranchesState; baseRef: string | undefined; defaultBase: string | undefined; onPick: (baseRef: string | undefined) => void }) {
  const { state, baseRef, defaultBase, onPick } = props;
  const [filter, setFilter] = useState("");
  const branches = useMemo(() => {
    if (state.status !== "ready") return [];
    const q = filter.trim().toLowerCase();
    return q ? state.data.branches.filter((b) => b.name.toLowerCase().includes(q)) : state.data.branches;
  }, [state, filter]);
  const note = describe(state);
  const row = "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm active:bg-accent/60 hover:bg-accent/60 min-h-11";
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-diff-branch-view="">
      <div className="border-b p-2">
        <Input type="search" size="sm" aria-label="Filter branches" placeholder="Filter branches" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-1" role="listbox" aria-label="Base branch">
        <button type="button" role="option" aria-selected={baseRef === undefined} className={row} onClick={() => onPick(undefined)}>
          <span className="min-w-0 flex-1 wrap-anywhere">Default base{defaultBase ? ` (${defaultBase})` : ""}</span>
          {baseRef === undefined ? <CheckIcon className="size-4 shrink-0" aria-hidden="true" /> : null}
        </button>
        {branches.map((b) => (
          <button key={b.name} type="button" role="option" aria-selected={baseRef === b.name} className={row} onClick={() => onPick(b.name)}>
            <span className="min-w-0 flex-1">
              <span className="block wrap-anywhere font-mono text-xs">{b.name}</span>
              <span className={cn("block text-xs text-muted-foreground", b.time <= 0 && "hidden")}>
                {b.remote ? "remote · " : ""}
                {b.time > 0 ? relativeTime(b.time) : ""}
              </span>
            </span>
            {baseRef === b.name ? <CheckIcon className="size-4 shrink-0" aria-hidden="true" /> : null}
          </button>
        ))}
        {note ? <p className="px-3 py-2 text-sm text-muted-foreground">{note}</p> : null}
        {state.status === "ready" && branches.length === 0 && filter.trim() ? <p className="px-3 py-2 text-sm text-muted-foreground">No branch matches.</p> : null}
        {state.status === "ready" && state.data.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground">Newest 200 branches shown.</p> : null}
      </div>
    </div>
  );
}
