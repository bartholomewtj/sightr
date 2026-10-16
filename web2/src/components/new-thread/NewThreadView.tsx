// The new-thread screen (T14): the draft (project, harness, model, effort, mode, placement, first
// message) and, after Start, the spawn progress. Laid out as T3's draft view: the hero headline with the
// project in it, the pickers, the "where" row, then the composer. On a phone it is a full screen with a
// back button; on desktop it fills the Chat region.
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { BranchToolbar } from "@/components/BranchToolbar";
import { DraftHeroHeadline } from "@/components/chat/DraftHeroHeadline";
import { ProviderModelPicker } from "@/components/chat/ProviderModelPicker";
import { TraitsPicker } from "@/components/chat/TraitsPicker";
import { useLayout } from "@/hooks/useLayout";
import {
  currentSplitSource,
  discardDraft,
  mountDraftScreen,
  openNewProjectForm,
  selectDraftProject,
  startDraft,
  takesFirstMessage,
  useDraftThread,
} from "@/state/draft-thread";
import { useShell } from "@/stream/stores";

import { DraftFirstMessage } from "./DraftFirstMessage";
import { HarnessPicker } from "./HarnessPicker";
import { NewProjectForm } from "./NewProjectForm";
import { commandPreview, createPayload, harnessTiles, isDestructiveMode, tileFor } from "./NewThread.logic";
import { SpawnProgress } from "./SpawnProgress";

export function NewThreadView({ projectId }: { projectId?: string }) {
  const desktop = useLayout() === "desktop";
  const start = useDraftThread((s) => s.start);
  const loaded = useShell((s) => s.loaded);
  const projectCount = useShell((s) => Object.values(s.projects).filter((p) => p.closedAt === undefined).length);
  const formOpen = useDraftThread((s) => s.form.open);

  useEffect(() => mountDraftScreen(), []);
  // A row's "+" or the palette preselects the project (only before a start).
  useEffect(() => {
    if (projectId && !useDraftThread.getState().start) selectDraftProject(projectId);
  }, [projectId]);
  // No projects yet: open on the New project form.
  useEffect(() => {
    if (loaded && projectCount === 0 && !useDraftThread.getState().form.open) openNewProjectForm();
  }, [loaded, projectCount]);

  return (
    <section aria-label="New thread" className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        {!desktop && (
          <Link to="/" aria-label="Back to threads" className="-ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent">
            <ChevronLeft className="size-5" />
          </Link>
        )}
        <h2 className="min-w-0 flex-1 truncate font-semibold">New thread</h2>
        {!start || start.phase === "failed" ? (
          <Button size="sm" variant="ghost" onClick={discardDraft}>
            Discard
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        {start ? (
          <SpawnProgress start={start} />
        ) : (
          <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-5">
            {projectCount > 0 || !loaded ? <DraftHeroHeadline /> : <h1 className="text-xl">Add a project to start</h1>}
            {formOpen ? <NewProjectForm canCancel={projectCount > 0} /> : null}
            <DraftBody />
          </div>
        )}
      </div>
    </section>
  );
}

function DraftBody() {
  const draft = useDraftThread((s) => s.draft);
  const startConfirm = useDraftThread((s) => s.startConfirm);
  const posting = useDraftThread((s) => s.posting);
  useShell((s) => s.threads);
  useDraftThread((s) => s.openThreadId);
  const tiles = useMemo(() => harnessTiles(), []);
  const tile = tileFor(draft.harness, tiles);
  const withMessage = takesFirstMessage(draft.harness);
  const preview = commandPreview(draft);
  const destructive = isDestructiveMode(draft.harness, draft.permissionMode);
  const check = createPayload(draft, currentSplitSource(), true);
  const canStart = check.ok && !posting;
  const hasText = withMessage && draft.text.trim() !== "";
  const submit = () => {
    if (canStart) void startDraft();
  };

  return (
    <>
      <HarnessPicker tiles={tiles} />
      {tile && !tile.plainShell ? (
        <div className="flex w-full flex-col gap-4">
          <ProviderModelPicker />
          <TraitsPicker />
        </div>
      ) : null}
      {tile ? <BranchToolbar /> : null}
      {tile && withMessage ? <DraftFirstMessage onSubmit={submit} /> : null}
      {preview ? <CommandLine text={preview} /> : null}
      <div className="flex w-full flex-col items-end gap-1.5">
        {startConfirm && destructive ? (
          <p role="alert" className="text-sm text-warn">
            The agent will run tools without asking. Tap again to start.
          </p>
        ) : null}
        {!check.ok && draft.projectId && tile ? <p className="text-xs text-muted-foreground">{check.reason}</p> : null}
        <Button disabled={!canStart} variant={startConfirm && destructive ? "destructive" : "default"} onClick={submit}>
          {startConfirm && destructive ? "Start with approvals off" : hasText ? "Start and send" : "Start"}
        </Button>
      </div>
    </>
  );
}

/** "Command": the command the bridge will run, collapsed. Display only; the bridge builds the real one. */
function CommandLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full text-xs text-muted-foreground">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 hover:text-foreground">
        {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        Command
      </button>
      {open ? (
        <code data-testid="draft-command" className="mt-1 block break-all rounded-md bg-muted px-2 py-1 font-mono">
          {text}
        </code>
      ) : null}
    </div>
  );
}
