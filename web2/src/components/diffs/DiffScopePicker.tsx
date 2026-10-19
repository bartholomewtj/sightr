// Sightr code (T27). What the Diff tab compares: the working tree, the branch against a base, or one run.
// T3 has a toggle and a base dropdown in its DiffPanel header; Sightr needs a phone path for the same thing.
// Desktop: a Base UI `ui/menu.tsx` dropdown (the base is a submenu). Phone: one `ui/sheet.tsx` bottom sheet
// with 44 px rows, whose second view picks the base; it is one history entry (`useSheetHistory`), so Back
// closes the picker and the next Back closes the panel under it.
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, GitBranchIcon, GitCompareIcon, PlayIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { sameScope, type DiffScope } from "@/diffPanelStore";
import { useLayout } from "@/hooks/useLayout";
import { cn } from "~/lib/utils";

import { useSheetHistory } from "../sheetHistory";
import { relativeTime } from "../right-panel/GitPanel.logic";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { DiffBranchMenu, DiffBranchSheetView, type BranchesState } from "./DiffBranchPicker";
import type { RunOption } from "./runScope";

export function scopeLabel(scope: DiffScope, defaultBase: string | undefined, runs: ReadonlyArray<RunOption>): string {
  if (scope.kind === "workingTree") return "Working tree";
  if (scope.kind === "branch") return `Branch vs ${scope.baseRef ?? defaultBase ?? "base"}`;
  const run = runs.find((r) => r.runId === scope.runId);
  return run ? `Run ${run.ordinal}` : "Run";
}

function runDetail(run: RunOption): string {
  return `${run.files} file${run.files === 1 ? "" : "s"} · ${relativeTime(run.at / 1000)}`;
}

export interface DiffScopePickerProps {
  scope: DiffScope;
  onScope: (scope: DiffScope) => void;
  runs: ReadonlyArray<RunOption>;
  /** The bridge's default base for this repo, once the branch list or a branch summary has said. */
  defaultBase: string | undefined;
  branches: BranchesState;
  /** Called when the base list is wanted (the picker opened its base view). */
  onWantBranches: () => void;
}

export function DiffScopePicker(props: DiffScopePickerProps) {
  const layout = useLayout();
  return layout === "desktop" ? <ScopeMenu {...props} /> : <ScopeSheet {...props} />;
}

function Trigger({ label }: { label: string }) {
  return (
    <>
      <GitCompareIcon aria-hidden="true" />
      <span className="max-w-[16rem] truncate">{label}</span>
      <ChevronDownIcon aria-hidden="true" className="opacity-70" />
    </>
  );
}

function ScopeMenu({ scope, onScope, runs, defaultBase, branches, onWantBranches }: DiffScopePickerProps) {
  const value = scope.kind === "workingTree" ? "w" : scope.kind === "branch" ? "b" : `r:${scope.runId}`;
  return (
    <Menu>
      <MenuTrigger
        data-diff-scope-trigger=""
        aria-label={`Compare: ${scopeLabel(scope, defaultBase, runs)}`}
        render={<Button size="xs" variant="outline" />}
      >
        <Trigger label={scopeLabel(scope, defaultBase, runs)} />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-64">
        <MenuRadioGroup
          value={value}
          onValueChange={(v) => {
            const next = String(v);
            if (next === "w") onScope({ kind: "workingTree" });
            else if (next === "b") onScope(scope.kind === "branch" ? scope : { kind: "branch" });
            else onScope({ kind: "run", runId: next.slice(2) });
          }}
        >
          <MenuRadioItem value="w">Working tree</MenuRadioItem>
          <MenuRadioItem value="b">Branch vs {scope.kind === "branch" ? (scope.baseRef ?? defaultBase ?? "base") : (defaultBase ?? "base")}</MenuRadioItem>
        </MenuRadioGroup>
        <DiffBranchMenu
          state={branches}
          baseRef={scope.kind === "branch" ? scope.baseRef : undefined}
          defaultBase={defaultBase}
          onOpen={onWantBranches}
          onPick={(baseRef) => onScope(baseRef ? { kind: "branch", baseRef } : { kind: "branch" })}
        />
        {runs.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Runs</MenuGroupLabel>
            <MenuRadioGroup value={value} onValueChange={(v) => onScope({ kind: "run", runId: String(v).slice(2) })}>
              {runs.map((run) => (
                <MenuRadioItem key={run.runId} value={`r:${run.runId}`}>
                  Run {run.ordinal} · {runDetail(run)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function ScopeSheet({ scope, onScope, runs, defaultBase, branches, onWantBranches }: DiffScopePickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"scope" | "base">("scope");
  const close = () => setOpen(false);
  useSheetHistory(open, close);
  const choose = (next: DiffScope) => {
    onScope(next);
    close();
  };
  const row = "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm min-h-11 active:bg-accent/60 hover:bg-accent/60";
  const option = (key: string, label: string, detail: string | undefined, target: DiffScope) => (
    <button key={key} type="button" role="option" aria-selected={sameScope(scope, target) || (target.kind === "branch" && scope.kind === "branch")} data-diff-scope-option={key} className={row} onClick={() => choose(target)}>
      <span className="min-w-0 flex-1">
        <span className="block wrap-anywhere">{label}</span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      {sameScope(scope, target) || (target.kind === "branch" && scope.kind === "branch") ? <CheckIcon className="size-4 shrink-0" aria-hidden="true" /> : null}
    </button>
  );
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        data-diff-scope-trigger=""
        aria-haspopup="dialog"
        aria-label={`Compare: ${scopeLabel(scope, defaultBase, runs)}`}
        onClick={() => {
          setView("scope");
          setOpen(true);
        }}
      >
        <Trigger label={scopeLabel(scope, defaultBase, runs)} />
      </Button>
      <Sheet open={open} onOpenChange={(next) => !next && close()}>
        <SheetPopup side="bottom" showCloseButton={false} className="max-h-[85dvh] rounded-t-2xl" data-diff-scope-sheet="">
          <div className="flex items-center gap-1 border-b px-2 py-1">
            {view === "base" ? (
              <Button size="icon-sm" variant="ghost" aria-label="Back to the comparison" onClick={() => setView("scope")}>
                <ArrowLeftIcon />
              </Button>
            ) : null}
            <SheetTitle className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{view === "base" ? "Base branch" : "Compare"}</SheetTitle>
            <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={close}>
              <XIcon />
            </Button>
          </div>
          {view === "scope" ? (
            <div role="listbox" aria-label="Compare" className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              {option("workingTree", "Working tree", "Uncommitted changes against HEAD", { kind: "workingTree" })}
              {option("branch", `Branch vs ${scope.kind === "branch" ? (scope.baseRef ?? defaultBase ?? "base") : (defaultBase ?? "base")}`, "Everything committed since it left the base", scope.kind === "branch" ? scope : { kind: "branch" })}
              <button
                type="button"
                className={cn(row, "text-muted-foreground")}
                data-diff-scope-option="base"
                onClick={() => {
                  onWantBranches();
                  setView("base");
                }}
              >
                <GitBranchIcon className="size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 wrap-anywhere">Base: {scope.kind === "branch" ? (scope.baseRef ?? defaultBase ?? "default") : (defaultBase ?? "default")}</span>
              </button>
              {runs.length > 0 ? <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">Runs</p> : null}
              {runs.map((run) => option(`run:${run.runId}`, `Run ${run.ordinal} · ${runDetail(run)}`, `+${run.additions} −${run.deletions} ${run.source === "checkpoint" ? "exact, from snapshots" : "from the agent's edits"}`, { kind: "run", runId: run.runId }))}
              {runs.length === 0 ? (
                <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                  <PlayIcon className="size-3 shrink-0" aria-hidden="true" />
                  No run in this thread has changed a file yet.
                </p>
              ) : null}
            </div>
          ) : (
            <DiffBranchSheetView
              state={branches}
              baseRef={scope.kind === "branch" ? scope.baseRef : undefined}
              defaultBase={defaultBase}
              onPick={(baseRef) => choose(baseRef ? { kind: "branch", baseRef } : { kind: "branch" })}
            />
          )}
        </SheetPopup>
      </Sheet>
    </>
  );
}
