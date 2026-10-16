// Same job and name as T3 Code's apps/web/src/components/chat/DraftHeroHeadline.tsx @ e3b35d1b (MIT, see
// THIRD_PARTY.md), Sightr's own body: "What should we build in {project}?" with the project picker in
// the sentence. T3's picker is a combobox popup; Sightr's opens inline under the headline (search, the
// project list in sidebar order with worktrees nested, then "New project…"), which reads the same on a
// phone. A project is a herdr workspace.
import { FolderPlusIcon, GitBranch } from "lucide-react";
import { useMemo, useState } from "react";

import { Input } from "~/components/ui/input";
import { usePaneFolder } from "@/components/right-panel/usePaneFolder";
import { projectEntries, searchProjects } from "@/components/new-thread/NewThread.logic";
import { cn } from "@/lib/utils";
import { openNewProjectForm, selectDraftProject, useDraftThread } from "@/state/draft-thread";
import { useShell } from "@/stream/stores";

export function DraftHeroHeadline() {
  const projects = useShell((s) => s.projects);
  const threads = useShell((s) => s.threads);
  const projectId = useDraftThread((s) => s.draft.projectId);
  const formOpen = useDraftThread((s) => s.form.open);
  const entries = useMemo(() => projectEntries(Object.values(projects), Object.values(threads)), [projects, threads]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => searchProjects(entries, query), [entries, query]);
  const active = projectId ? (projects[projectId] ?? null) : null;

  const choose = (id: string) => {
    selectDraftProject(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="flex w-full flex-col items-center gap-2">
      <h1 className="w-full text-center text-xl font-normal tracking-tight text-foreground sm:text-2xl">
        {active ? "What should we build in " : null}
        <button
          type="button"
          aria-expanded={open}
          aria-controls="draft-project-picker"
          data-draft-project-trigger=""
          onClick={() => setOpen((o) => !o)}
          className="border-b border-dotted border-muted-foreground/60 text-foreground outline-none hover:border-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
        >
          {active ? active.label : "Choose a project"}
        </button>
        {active ? "?" : " to start"}
      </h1>
      {active ? <ProjectFolder projectId={active.id} /> : null}
      {open ? (
        <div id="draft-project-picker" className="w-full max-w-md rounded-lg border bg-card p-2 shadow-sm">
          <Input
            type="search"
            aria-label="Search projects"
            placeholder="Search projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <ul role="listbox" aria-label="Projects" className="mt-1 max-h-72 overflow-y-auto">
            {shown.length === 0 && query.trim() ? <li className="px-2 py-1.5 text-sm text-muted-foreground">No matching projects.</li> : null}
            {shown.map((e) => (
              <li key={e.project.id} role="option" aria-selected={e.project.id === projectId}>
                <button
                  type="button"
                  onClick={() => choose(e.project.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                    e.nested && "pl-6",
                    e.project.id === projectId && "bg-accent",
                  )}
                >
                  {e.nested ? <GitBranch className="size-3.5 text-muted-foreground" role="img" aria-label="Worktree" /> : null}
                  <span className="min-w-0 flex-1 truncate">{e.project.label}</span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{e.project.number}</span>
                  <span className="text-xs text-muted-foreground">
                    {e.threadCount} {e.threadCount === 1 ? "thread" : "threads"}
                  </span>
                </button>
              </li>
            ))}
            <li role="option" aria-selected={formOpen}>
              <button
                type="button"
                onClick={() => {
                  openNewProjectForm();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <FolderPlusIcon className="size-4" aria-hidden />
                New project…
              </button>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The project's folder, read-only. The client never holds absolute paths (ADR 0026), so this is the
 * folder of one of the project's live panes as the Files root names it; nothing shows when the project
 * has no pane yet or Files is off.
 */
function ProjectFolder({ projectId }: { projectId: string }) {
  const paneId = useShell((s) => Object.values(s.threads).find((t) => t.projectId === projectId && t.shelf !== "archived")?.paneId ?? null);
  const { path } = usePaneFolder(paneId);
  if (!path) return null;
  return (
    <p className="max-w-full truncate font-mono text-xs text-muted-foreground" title={path}>
      {path || "."}
    </p>
  );
}
