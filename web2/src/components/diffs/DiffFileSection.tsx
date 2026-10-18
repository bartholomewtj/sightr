// Sightr code (T27). One changed file in the Diff panel: a sticky header (status chip, the path wrapping and
// clamped to three lines, +N/-M, Copy path, Open in Files; each 44 px on a touch screen) over its body, which
// depends on where the file's patch stands: loading, the diff, a cut diff with what was cut, an error with
// Retry, or "binary". The diff itself is `DiffCodeView` (T25's seam) inside an error boundary: a rejected
// renderer import goes to the nearest boundary, and this is it; the fallback is the plain lines.
import { ChevronRightIcon, FileSymlinkIcon, RotateCwIcon } from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { DiffFilePathCopyButton } from "@/components/DiffFilePathCopyButton";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";

import { DiffCodeView, PlainPatch, resetDiffRenderer } from "./DiffCodeView";
import { editsLabel, fileLabel } from "./diffFileActions";
import { DiffFileStatus } from "./DiffFileStatus";
import { patchOf, type DiffFileEntry, type PatchState } from "./diffTypes";

/** The diff, or plain lines if the renderer cannot load (with a Retry that asks for it again). */
export function PatchBody({ patch, path, wrap, eager }: { patch: string; path: string; wrap: boolean; eager: boolean }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <RenderErrorBoundary
      resetKeys={[attempt]}
      fallback={
        <div data-diff-viewer-failed="">
          <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
            <span>The diff viewer didn't load, so this is plain text.</span>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => {
                resetDiffRenderer();
                setAttempt((n) => n + 1);
              }}
            >
              <RotateCwIcon aria-hidden="true" />
              Retry
            </Button>
          </div>
          <PlainPatch patch={patch} wrap={wrap} />
        </div>
      }
    >
      <DiffCodeView patch={patch} filePath={path} wrap={wrap} eager={eager} header={false} />
    </RenderErrorBoundary>
  );
}

function Note({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" }) {
  return <p className={cn("px-2 py-1.5 text-xs", tone === "warn" ? "text-[var(--warn)]" : "text-muted-foreground")}>{children}</p>;
}

function Body(props: { file: DiffFileEntry; state: PatchState; wrap: boolean; eager: boolean; canOpen: boolean; onRetry: () => void; onOpenInFiles: () => void }) {
  const { file, state, wrap, eager, canOpen, onRetry, onOpenInFiles } = props;
  const patch = patchOf(state);
  const diff = patch !== null && patch.trim() !== "" ? <PatchBody patch={patch} path={file.path} wrap={wrap} eager={eager} /> : null;
  switch (state.state) {
    case "idle":
    case "loading":
      return diff ? <div aria-busy="true" data-diff-revalidating="">{diff}</div> : <Note>Loading…</Note>;
    case "binary":
      return <Note>Binary file: there is no patch to show.</Note>;
    case "error":
      return (
        <div data-diff-error="">
          {diff}
          <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
            <p role="alert" className="min-w-0 flex-1 text-xs text-[var(--warn)] wrap-anywhere">
              {state.message}
            </p>
            {state.retryable ? (
              <Button size="xs" variant="outline" onClick={onRetry}>
                <RotateCwIcon aria-hidden="true" />
                Retry
              </Button>
            ) : null}
          </div>
        </div>
      );
    case "truncated":
      return (
        <div data-diff-truncated="">
          {diff}
          <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground wrap-anywhere">{state.message}</p>
            {canOpen ? (
              <Button size="xs" variant="outline" onClick={onOpenInFiles}>
                <FileSymlinkIcon aria-hidden="true" />
                Open in Files
              </Button>
            ) : null}
          </div>
        </div>
      );
    case "ready":
      return diff ?? <Note>{file.kind === "renamed" ? "Renamed, no content change." : "No changes to show."}</Note>;
  }
}

export const DiffFileSection = memo(function DiffFileSection(props: {
  file: DiffFileEntry;
  state: PatchState;
  unfolded: boolean;
  wrap: boolean;
  eager: boolean;
  highlighted: boolean;
  canOpen: boolean;
  onToggle: (path: string) => void;
  onRetry: (path: string) => void;
  onOpenInFiles: (file: DiffFileEntry) => void;
}) {
  const { file, state, unfolded, wrap, eager, highlighted, canOpen, onToggle, onRetry, onOpenInFiles } = props;
  const bodyId = `diff-body-${file.path}`;
  const edits = editsLabel(file.edits);
  return (
    <section data-diff-file={file.path} data-diff-state={state.state} className={cn("border-b motion-safe:transition-colors motion-safe:duration-700", highlighted && "bg-accent/60")}>
      <h3 className="sticky top-0 z-10 flex items-start gap-1 border-b bg-background pe-1">
        <button
          type="button"
          aria-expanded={unfolded}
          aria-controls={unfolded ? bodyId : undefined}
          onClick={() => onToggle(file.path)}
          className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left pointer-coarse:min-h-11 pointer-coarse:py-2.5"
        >
          <ChevronRightIcon aria-hidden="true" className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", unfolded && "rotate-90")} />
          <DiffFileStatus kind={file.kind} className="mt-0.5" />
          <span className="min-w-0 flex-1 line-clamp-3 font-mono text-xs font-normal wrap-anywhere" title={fileLabel(file)} data-diff-file-label="">
            {fileLabel(file)}
          </span>
          <span className="ml-auto shrink-0 text-xs">
            {file.binary ? (
              <span className="font-mono text-3xs text-muted-foreground">binary</span>
            ) : file.countsKnown ? (
              <DiffStatLabel additions={file.added} deletions={file.removed} layout="inline" />
            ) : null}
            {edits ? <span className="ml-1 text-3xs text-muted-foreground">{edits}</span> : null}
          </span>
        </button>
        <DiffFilePathCopyButton filePath={file.path} />
        {canOpen ? (
          <Button size="icon-xs" variant="ghost-muted" aria-label={`Open ${file.path} in Files`} title="Open in Files" onClick={() => onOpenInFiles(file)}>
            <FileSymlinkIcon />
          </Button>
        ) : null}
      </h3>
      {unfolded ? (
        <div id={bodyId} data-diff-body="">
          <Body file={file} state={state} wrap={wrap} eager={eager} canOpen={canOpen} onRetry={() => onRetry(file.path)} onOpenInFiles={() => onOpenInFiles(file)} />
        </div>
      ) : null}
    </section>
  );
});
